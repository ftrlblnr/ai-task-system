import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../prisma/prisma.service';
import { SecretBoxService } from '../crypto/secret-box.service';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
];

// Раздел 14.2 ТЗ / Адъютант (скорректировано владельцем 28.08.2026):
// двусторонняя синхронизация внутреннего календаря с Google Calendar
// руководителя. OAuth-обмен инкапсулирован здесь; сам refresh-токен
// шифруется перед сохранением (SecretBoxService) — см. GoogleCalendarConnection.
@Injectable()
export class GoogleOAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly secretBox: SecretBoxService,
  ) {}

  // clientId/clientSecret — из БД (владелец вводит сам в личном кабинете,
  // раздел 14.2 ТЗ), не из .env: смена ключа не должна требовать помощи
  // разработчика и пересборки контейнера. GOOGLE_REDIRECT_URI остаётся в
  // .env — он завязан на домен деплоя, владелец его не выбирает.
  private async getCredentials(): Promise<{ clientId: string; clientSecret: string }> {
    const row = await this.prisma.googleOAuthAppConfig.findUnique({ where: { id: 'singleton' } });
    if (!row) {
      throw new UnauthorizedException(
        'Google OAuth-клиент не настроен — введите Client ID и Client Secret в личном кабинете',
      );
    }
    return { clientId: row.clientId, clientSecret: this.secretBox.decrypt(row.clientSecretEncrypted) };
  }

  async isConfigured(): Promise<boolean> {
    const row = await this.prisma.googleOAuthAppConfig.findUnique({
      where: { id: 'singleton' },
      select: { id: true },
    });
    return Boolean(row);
  }

  // clientSecret никогда не возвращается наружу целиком после сохранения —
  // только clientId, чтобы личный кабинет мог показать "уже введено:
  // ...123" без повторной расшифровки секрета ради простого отображения.
  async getPublicConfig(): Promise<{ clientId: string } | null> {
    const row = await this.prisma.googleOAuthAppConfig.findUnique({
      where: { id: 'singleton' },
      select: { clientId: true },
    });
    return row;
  }

  async setCredentials(clientId: string, clientSecret: string): Promise<void> {
    await this.prisma.googleOAuthAppConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', clientId, clientSecretEncrypted: this.secretBox.encrypt(clientSecret) },
      update: { clientId, clientSecretEncrypted: this.secretBox.encrypt(clientSecret) },
    });
  }

  private async newClient(): Promise<OAuth2Client> {
    const { clientId, clientSecret } = await this.getCredentials();
    return new google.auth.OAuth2(clientId, clientSecret, this.config.getOrThrow<string>('GOOGLE_REDIRECT_URI'));
  }

  // state — короткоживущий подписанный токен с employeeId, а не сырой id:
  // callback дергает сам Google без нашего JWT в заголовке, state — единственная
  // защита от подмены/CSRF на этом шаге (verify при обмене кода на токены).
  async buildAuthUrl(employeeId: string): Promise<string> {
    const state = this.jwt.sign({ employeeId, purpose: 'google-calendar-connect' }, { expiresIn: '10m' });
    const client = await this.newClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // иначе Google не всегда возвращает refresh_token повторно
      scope: SCOPES,
      state,
    });
  }

  verifyState(state: string): string {
    try {
      const payload = this.jwt.verify<{ employeeId: string; purpose: string }>(state);
      if (payload.purpose !== 'google-calendar-connect') throw new Error('wrong purpose');
      return payload.employeeId;
    } catch {
      throw new UnauthorizedException('Недействительный или истёкший state — начните подключение заново');
    }
  }

  async connect(employeeId: string, code: string): Promise<void> {
    const { clientId } = await this.getCredentials();
    const client = await this.newClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new UnauthorizedException(
        'Google не вернул refresh-токен — отключите приложение в аккаунте Google (myaccount.google.com/permissions) и подключите заново',
      );
    }

    client.setCredentials(tokens);
    let email = 'unknown';
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: clientId,
      });
      email = ticket.getPayload()?.email ?? email;
    }

    await this.prisma.googleCalendarConnection.upsert({
      where: { employeeId },
      create: {
        employeeId,
        googleAccountEmail: email,
        refreshTokenEncrypted: this.secretBox.encrypt(tokens.refresh_token),
      },
      update: {
        googleAccountEmail: email,
        refreshTokenEncrypted: this.secretBox.encrypt(tokens.refresh_token),
        // Новое подключение — предыдущий канал/sync-токен больше не валиден.
        syncToken: null,
        channelId: null,
        channelResourceId: null,
        channelExpiresAt: null,
      },
    });
  }

  // Авторизованный клиент для конкретного сотрудника (на практике — только
  // руководитель). googleapis сам обновляет access_token по refresh_token
  // при вызовах API; на ротацию refresh_token (redкий случай) реагируем
  // через событие 'tokens' и перезаписываем зашифрованную копию.
  async getAuthorizedClient(employeeId: string): Promise<OAuth2Client> {
    const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { employeeId } });
    if (!connection) {
      throw new UnauthorizedException('Google Calendar не подключён');
    }

    const client = await this.newClient();
    client.setCredentials({ refresh_token: this.secretBox.decrypt(connection.refreshTokenEncrypted) });

    client.on('tokens', (tokens) => {
      if (!tokens.refresh_token) return;
      this.prisma.googleCalendarConnection
        .update({
          where: { employeeId },
          data: { refreshTokenEncrypted: this.secretBox.encrypt(tokens.refresh_token) },
        })
        .catch(() => {});
    });

    return client;
  }

  async disconnect(employeeId: string): Promise<void> {
    const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { employeeId } });
    if (!connection) return;

    try {
      const client = await this.getAuthorizedClient(employeeId);
      await client.revokeCredentials();
    } catch {
      // best-effort — даже если отзыв на стороне Google не удался, локально
      // подключение всё равно убираем
    }

    await this.prisma.googleCalendarConnection.delete({ where: { employeeId } });
  }
}

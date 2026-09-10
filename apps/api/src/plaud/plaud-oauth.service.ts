import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretBoxService } from '../crypto/secret-box.service';

// Реальные эндпоинты подтверждены чтением исходников @plaud-ai/cli
// (node_modules/@plaud-ai/cli/dist/index.js на момент разведки 08.09.2026) —
// в официальной документации docs.plaud.ai эта часть API не описана.
const REFRESH_URL = 'https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh';

// У Plaud нет self-service регистрации OAuth-приложения для доступа к
// своим же записям (владелец 09.09.2026 выяснил: portal.plaud.ai — это
// отдельный продукт, Plaud Embedded, для встраивания устройств в чужие
// приложения чужими конечными пользователями, не для этого сценария).
//
// Изначально пытались переиспользовать публичный клиент @plaud-ai/cli
// (`client_f9e0b214-c11f-434b-8b95-c4497d1feb81`, без client_secret) с
// собственным redirect_uri на нашем домене через полноценный browser OAuth-
// редирект — но владелец эмпирически воспроизвёл 400 Bad Request от Plaud
// именно на шаге подтверждения (Allow), хотя экран согласия загружался
// нормально. Похоже, Plaud валидирует redirect_uri строго на confirm-шаге
// (только их же localhost:8199, зарегистрированный за этим client_id),
// просто не на рендере страницы. Значит OAuth-редирект через наш домен для
// этого клиента в принципе не пройдёт.
//
// Рабочий обходной путь (владелец 09.09.2026): @plaud-ai/cli прекрасно
// работает НА МАШИНЕ ПОЛЬЗОВАТЕЛЯ (localhost:8199 — их собственный
// зарегистрированный redirect, там уже подтверждено рабочим), и после
// успешного `plaud login` сохраняет токены в `~/.plaud/tokens.json`
// (TokenStore, дефолтное имя файла) в виде {access_token, refresh_token,
// expires_in, ...}. Мы просто просим владельца один раз вставить оттуда
// refresh_token к нам напрямую (connectWithRefreshToken ниже) — никакого
// браузерного редиректа через наш домен не требуется вообще, а refresh
// grant (в отличие от authorization code grant) не участвует redirect_uri,
// так что дальнейшее автообновление токена (getAccessToken) работает как
// обычно — refresh-запрос (см. refresh() ниже) вообще не требует client_id/
// secret, только refresh_token (подтверждено чтением исходников CLI).
interface PlaudTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

@Injectable()
export class PlaudOAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secretBox: SecretBoxService,
  ) {}

  private async refresh(refreshToken: string): Promise<PlaudTokenResponse> {
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      throw new UnauthorizedException(`Обновление токена Plaud не удалось: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as PlaudTokenResponse;
  }

  // Владелец получает refreshToken локально через `plaud login` (см.
  // комментарий у класса) и вставляет его один раз в форму на /meetings.
  // Сразу же обновляем его, чтобы (а) убедиться, что токен рабочий, прежде
  // чем сохранять, и (б) получить свежий access_token.
  async connectWithRefreshToken(employeeId: string, refreshToken: string): Promise<void> {
    const tokens = await this.refresh(refreshToken);
    const effectiveRefreshToken = tokens.refresh_token ?? refreshToken;

    await this.prisma.plaudConnection.upsert({
      where: { employeeId },
      create: {
        employeeId,
        accessTokenEncrypted: this.secretBox.encrypt(tokens.access_token),
        refreshTokenEncrypted: this.secretBox.encrypt(effectiveRefreshToken),
        tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      },
      update: {
        accessTokenEncrypted: this.secretBox.encrypt(tokens.access_token),
        refreshTokenEncrypted: this.secretBox.encrypt(effectiveRefreshToken),
        tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
        // Новое подключение — курсор синхронизации сбрасываем, чтобы не
        // унаследовать позицию от предыдущей (возможно, отозванной) связки.
        lastSyncedCreatedAt: null,
      },
    });
  }

  // Ленивый рефреш-на-чтение — у Plaud нет SDK с автоматическим хуком, как
  // у google-auth-library, поэтому проверяем срок сами перед каждым вызовом
  // (тот же 60-секундный запас, что использует сам @plaud-ai/cli).
  async getAccessToken(employeeId: string): Promise<string> {
    const connection = await this.prisma.plaudConnection.findUnique({ where: { employeeId } });
    if (!connection) {
      throw new UnauthorizedException('Plaud не подключён');
    }

    const expiringSoon = connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() - Date.now() < 60_000;
    if (!expiringSoon) {
      return this.secretBox.decrypt(connection.accessTokenEncrypted);
    }

    const tokens = await this.refresh(this.secretBox.decrypt(connection.refreshTokenEncrypted));

    await this.prisma.plaudConnection.update({
      where: { employeeId },
      data: {
        accessTokenEncrypted: this.secretBox.encrypt(tokens.access_token),
        refreshTokenEncrypted: tokens.refresh_token
          ? this.secretBox.encrypt(tokens.refresh_token)
          : connection.refreshTokenEncrypted,
        tokenExpiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      },
    });
    return tokens.access_token;
  }

  // Специального revoke-эндпоинта для стороннего приложения в открытой
  // (open/third-party) части API Plaud нет — убираем локальную связку,
  // токен истечёт сам.
  async disconnect(employeeId: string): Promise<void> {
    await this.prisma.plaudConnection.deleteMany({ where: { employeeId } });
  }
}

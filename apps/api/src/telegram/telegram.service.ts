import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import {
  InvalidTelegramInitDataError,
  verifyTelegramInitData,
  type VerifiedTelegramInitData,
} from './telegram-init-data';

const INVITE_TTL_MINUTES = 30;

const AUTH_SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  isProfileAdmin: true,
  status: true,
} as const;

@Injectable()
export class TelegramService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  // Руководитель не знает telegram id сотрудника заранее — генерируем
  // одноразовый токен. Ссылка открывает Telegram Mini App (не бота): в
  // Mini App попадает start_param = токен внутри подписанной initData,
  // и сотрудник привязывает себя сам через POST /auth/telegram.
  async createInvite(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, telegramId: true },
    });
    if (!employee) throw new NotFoundException('Сотрудник не найден');
    if (employee.telegramId) {
      throw new ConflictException('У сотрудника уже привязан Telegram — сначала отвяжите текущий');
    }

    // Предыдущие неиспользованные приглашения этого сотрудника аннулируем —
    // действует только последняя ссылка.
    await this.prisma.telegramInvite.deleteMany({
      where: { employeeId, usedAt: null },
    });

    const token = randomBytes(24).toString('base64url');
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MINUTES * 60_000);

    await this.prisma.telegramInvite.create({
      data: { employeeId, tokenHash, expiresAt },
    });

    const botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME');
    const miniAppName = this.config.get<string>('TELEGRAM_MINIAPP_SHORT_NAME');
    return {
      token,
      expiresAt,
      deepLink:
        botUsername && miniAppName ? `https://t.me/${botUsername}/${miniAppName}?startapp=${token}` : null,
    };
  }

  // Вызывается Mini App при каждом открытии. Источник доверия — подпись
  // initData (проверяется bot token'ом), а не отдельный секрет.
  // Если в initData есть start_param — это приглашение, привязываем Telegram
  // к указанному в нём сотруднику. Если нет и credentials не переданы — это
  // обычный вход уже привязанного сотрудника. Если нет и credentials
  // переданы (владелец 02.10.2026, самостоятельная регистрация) — логин
  // проверяется как обычный пароль (см. AuthService.validateCredentials), и
  // при успехе этот Telegram-аккаунт привязывается тут же, одним действием —
  // отдельного приглашения руководителя не требуется.
  async authenticate(rawInitData: string, credentials?: { login: string; password: string }) {
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      throw new UnauthorizedException('Вход через Telegram не настроен (TELEGRAM_BOT_TOKEN)');
    }

    // Тип указан явно (аудит 10.09.2026, п. 5.2) — `let verified;` без
    // аннотации и без инициализатора TS выводит как any, из-за чего
    // .user/.startParam ниже проходили мимо @typescript-eslint/no-unsafe-*
    // незамеченными до первого реального прогона lint в CI.
    let verified: VerifiedTelegramInitData;
    try {
      verified = verifyTelegramInitData(rawInitData, botToken);
    } catch (err) {
      if (err instanceof InvalidTelegramInitDataError) {
        throw new UnauthorizedException('Не удалось подтвердить данные Telegram: ' + err.message);
      }
      throw err;
    }

    const telegramUserId = String(verified.user.id);

    const employee = verified.startParam
      ? await this.consumeInvite(verified.startParam, telegramUserId)
      : await this.findByTelegramId(telegramUserId, credentials);

    if (employee.status !== 'ACTIVE') {
      throw new UnauthorizedException('Учётная запись отключена — обратитесь к руководителю');
    }

    return employee;
  }

  private async findByTelegramId(telegramUserId: string, credentials?: { login: string; password: string }) {
    const employee = await this.prisma.employee.findUnique({
      where: { telegramId: telegramUserId },
      select: AUTH_SELECT,
    });
    if (employee) return employee;

    if (credentials) {
      return this.linkViaCredentials(credentials.login, credentials.password, telegramUserId);
    }

    // Код NO_EMPLOYEE_LINKED в начале сообщения — Mini App (auth-context.tsx)
    // распознаёт именно эту причину 401, чтобы вместо голого текста ошибки
    // показать форму входа логином/паролем (тот же приём, что RECEPTION_BUSY
    // в reception.service.ts).
    throw new UnauthorizedException(
      'NO_EMPLOYEE_LINKED: этот Telegram-аккаунт не привязан ни к одному сотруднику',
    );
  }

  private async linkViaCredentials(login: string, password: string, telegramUserId: string) {
    const employee = await this.authService.validateCredentials(login, password);
    if (!employee) {
      throw new UnauthorizedException('Неверный логин или пароль');
    }

    await this.ensureTelegramFree(telegramUserId, employee.id);

    return this.prisma.employee.update({
      where: { id: employee.id },
      data: { telegramId: telegramUserId },
      select: AUTH_SELECT,
    });
  }

  private async consumeInvite(token: string, telegramUserId: string) {
    const tokenHash = this.hash(token);
    const invite = await this.prisma.telegramInvite.findUnique({ where: { tokenHash } });

    if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
      throw new UnauthorizedException('Приглашение недействительно или истекло — запросите новую ссылку');
    }

    await this.ensureTelegramFree(telegramUserId, invite.employeeId);

    const [employee] = await this.prisma.$transaction([
      this.prisma.employee.update({
        where: { id: invite.employeeId },
        data: { telegramId: telegramUserId },
        select: AUTH_SELECT,
      }),
      this.prisma.telegramInvite.update({ where: { id: invite.id }, data: { usedAt: new Date() } }),
    ]);

    return employee;
  }

  // Общая проверка для обоих путей привязки (invite-токен и пароль
  // самостоятельной регистрации) — этот Telegram-аккаунт не должен уже
  // принадлежать ДРУГОМУ сотруднику.
  private async ensureTelegramFree(telegramUserId: string, employeeId: string) {
    const existingLink = await this.prisma.employee.findUnique({ where: { telegramId: telegramUserId } });
    if (existingLink && existingLink.id !== employeeId) {
      throw new ConflictException('Этот Telegram-аккаунт уже привязан к другому сотруднику');
    }
  }

  async unlink(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
    if (!employee) throw new NotFoundException('Сотрудник не найден');

    await this.prisma.employee.update({ where: { id: employeeId }, data: { telegramId: null } });
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { InvalidTelegramInitDataError, verifyTelegramInitData } from './telegram-init-data';

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
  // к указанному в нём сотруднику. Если нет — это обычный вход уже
  // привязанного сотрудника.
  async authenticate(rawInitData: string) {
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      throw new UnauthorizedException('Вход через Telegram не настроен (TELEGRAM_BOT_TOKEN)');
    }

    let verified;
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
      : await this.findByTelegramId(telegramUserId);

    if (employee.status !== 'ACTIVE') {
      throw new UnauthorizedException('Учётная запись отключена — обратитесь к руководителю');
    }

    return employee;
  }

  private async findByTelegramId(telegramUserId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { telegramId: telegramUserId },
      select: AUTH_SELECT,
    });
    if (!employee) {
      throw new UnauthorizedException(
        'Этот Telegram-аккаунт не привязан ни к одному сотруднику — запросите приглашение у руководителя',
      );
    }
    return employee;
  }

  private async consumeInvite(token: string, telegramUserId: string) {
    const tokenHash = this.hash(token);
    const invite = await this.prisma.telegramInvite.findUnique({ where: { tokenHash } });

    if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
      throw new UnauthorizedException('Приглашение недействительно или истекло — запросите новую ссылку');
    }

    const existingLink = await this.prisma.employee.findUnique({ where: { telegramId: telegramUserId } });
    if (existingLink && existingLink.id !== invite.employeeId) {
      throw new ConflictException('Этот Telegram-аккаунт уже привязан к другому сотруднику');
    }

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

  async unlink(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } });
    if (!employee) throw new NotFoundException('Сотрудник не найден');

    await this.prisma.employee.update({ where: { id: employeeId }, data: { telegramId: null } });
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

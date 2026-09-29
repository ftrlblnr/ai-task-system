import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { localDateString, TIMEZONE_OFFSET_STRING } from '../common/timezone';
import { MailQueryService } from './mail-query.service';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// Release 2 — утренняя сводка важной почты, отдельный cron от
// tasks/daily-digest.cron.ts (другой домен: один ящик на владельца, не
// цикл по всем сотрудникам) — та же политика "без шума": пусто → ни строки
// в EmailDigest, ни сообщения в Telegram.
@Injectable()
export class MailDigestCron {
  private readonly logger = new Logger(MailDigestCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly query: MailQueryService,
    private readonly bot: TelegramBotService,
  ) {}

  // '0 5 3 * * *' — 3:05 UTC = 8:05 Алматы, через 5 минут после дайджеста
  // задач (daily-digest.cron.ts, 3:00 UTC) — не перемешивает порядок двух
  // сообщений у владельца.
  @Cron('0 5 3 * * *')
  async sendDigest(): Promise<void> {
    const mailboxes = await this.prisma.mailbox.findMany({
      where: { syncEnabled: true },
      select: { id: true, employee: { select: { telegramId: true } } },
    });

    for (const mailbox of mailboxes) {
      if (!mailbox.employee.telegramId) continue;
      try {
        await this.sendOne(mailbox.id, mailbox.employee.telegramId);
      } catch (err) {
        this.logger.warn(`mail digest failed mailbox=${mailbox.id}: ${err instanceof Error ? err.name : 'unknown'}`);
      }
    }
  }

  private async sendOne(mailboxId: string, telegramId: string): Promise<void> {
    // Период — предыдущие календарные сутки по Алматы: localDateString уже
    // учитывает смещение (см. её комментарий и урок DailyDigestCron про
    // сравнение дат в UTC).
    const todayLocal = localDateString(new Date());
    const periodTo = new Date(`${todayLocal}T00:00:00${TIMEZONE_OFFSET_STRING}`);
    const periodFrom = new Date(periodTo.getTime() - 24 * 60 * 60 * 1000);

    const items = await this.query.findImportantForDigest(mailboxId, periodFrom, periodTo);
    if (items.length === 0) return;

    try {
      await this.prisma.emailDigest.create({
        data: { mailboxId, periodFrom, periodTo, content: items as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      // Уникальный индекс [mailboxId, periodFrom, periodTo] — сводка за
      // этот период уже отправлена (повторный запуск после рестарта
      // процесса) — не дублируем сообщение в Telegram.
      if (isUniqueConstraintError(err)) return;
      throw err;
    }

    const lines = [
      'Доброе утро! Важное в почте за сутки:',
      '',
      ...items.map((i) => `• ${i.fromName || i.fromAddress} — ${i.subject || '(без темы)'}${i.analysis?.summary ? `: ${i.analysis.summary}` : ''}`),
    ];
    void this.bot.sendMessage(telegramId, lines.join('\n'));
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MailProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { localDateString, TIMEZONE_OFFSET_STRING } from '../common/timezone';
import { MailQueryService, type DigestEmailItem } from './mail-query.service';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// Источник (владелец 29.09.2026: сейчас только Mail.ru, дальше планируются
// другие провайдеры) — и в Telegram-сообщении, и на вкладке «Дайджест» в
// вебе (mail.controller.ts переиспользует этот же экспорт). Единственное
// место, где заводить label для нового значения MailProvider при расширении.
export const PROVIDER_LABELS: Record<MailProvider, string> = {
  MAIL_RU: 'Mail.ru',
};

const IMPORTANCE_LABELS: Record<string, string> = { CRITICAL: 'Критично', IMPORTANT: 'Важно', NORMAL: '', LOW: '' };

// Telegram режет сообщения длиннее 4096 UTF-16 code units — берём с запасом,
// длинный день (много писем) обрезается по количеству строк, не по байтам
// посередине письма.
const MAX_DIGEST_TEXT_CHARS = 3800;

export function formatTime(date: Date | null): string {
  if (!date) return '';
  const localMs = date.getTime() + 5 * 60 * 60 * 1000;
  return new Date(localMs).toISOString().slice(11, 16);
}

export function formatItem(i: Pick<DigestEmailItem, 'subject' | 'fromAddress' | 'fromName' | 'receivedAt' | 'analysis'>): string {
  const time = formatTime(i.receivedAt);
  const who = i.fromName || i.fromAddress;
  const subject = i.subject || '(без темы)';
  const badges: string[] = [];
  if (i.analysis?.status === 'COMPLETED') {
    const impLabel = i.analysis.importance ? IMPORTANCE_LABELS[i.analysis.importance] : '';
    if (impLabel) badges.push(impLabel);
    if (i.analysis.needsReply) badges.push('нужен ответ');
    if (i.analysis.needsAction) badges.push('нужно действие');
  }
  const badgeText = badges.length > 0 ? ` [${badges.join(', ')}]` : '';
  const summary = i.analysis?.summary ? `: ${i.analysis.summary}` : '';
  return `• ${time} ${who} — ${subject}${badgeText}${summary}`;
}

// Release 2 — ежедневная аналитика по всей входящей почте за прошедшие
// сутки (владелец 29.09.2026: не только важное — полный список с кратким
// содержанием и важностью по каждому письму). Отдельный cron от
// tasks/daily-digest.cron.ts (другой домен: один ящик на владельца, не
// цикл по всем сотрудникам). В отличие от дайджеста задач — присылается
// ВСЕГДА в фиксированное время, даже если писем не было (владелец
// 29.09.2026: это теперь ежедневная аналитика в фиксированное время, не
// точечное уведомление только по поводу).
@Injectable()
export class MailDigestCron {
  private readonly logger = new Logger(MailDigestCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly query: MailQueryService,
    private readonly bot: TelegramBotService,
  ) {}

  // '0 0 1 * * *' — 1:00 UTC = 06:00 Алматы (владелец 29.09.2026).
  @Cron('0 0 1 * * *')
  async sendDigest(): Promise<void> {
    const mailboxes = await this.prisma.mailbox.findMany({
      where: { syncEnabled: true },
      select: { id: true, emailAddress: true, provider: true, employee: { select: { telegramId: true } } },
    });

    for (const mailbox of mailboxes) {
      if (!mailbox.employee.telegramId) continue;
      try {
        await this.sendOne(mailbox.id, mailbox.emailAddress, mailbox.provider, mailbox.employee.telegramId);
      } catch (err) {
        this.logger.warn(`mail digest failed mailbox=${mailbox.id}: ${err instanceof Error ? err.name : 'unknown'}`);
      }
    }
  }

  private async sendOne(mailboxId: string, emailAddress: string, provider: MailProvider, telegramId: string): Promise<void> {
    // Период — предыдущие календарные сутки по Алматы: localDateString уже
    // учитывает смещение (см. её комментарий и урок DailyDigestCron про
    // сравнение дат в UTC).
    const todayLocal = localDateString(new Date());
    const periodTo = new Date(`${todayLocal}T00:00:00${TIMEZONE_OFFSET_STRING}`);
    const periodFrom = new Date(periodTo.getTime() - 24 * 60 * 60 * 1000);

    const items = await this.query.findAllForDigest(mailboxId, periodFrom, periodTo);

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

    const source = `${PROVIDER_LABELS[provider] ?? provider}, ${emailAddress}`;
    const header = `Почта за ${localDateString(periodFrom)} (${source}):`;
    const lines = [header, ''];

    if (items.length === 0) {
      lines.push('Писем не было.');
    } else {
      const itemLines = items.map(formatItem);
      let used = header.length + 1;
      const kept: string[] = [];
      for (const line of itemLines) {
        if (used + line.length + 1 > MAX_DIGEST_TEXT_CHARS) break;
        kept.push(line);
        used += line.length + 1;
      }
      lines.push(...kept);
      if (kept.length < itemLines.length) lines.push('', `…и ещё ${itemLines.length - kept.length} писем.`);
    }

    void this.bot.sendMessage(telegramId, lines.join('\n'));
  }
}

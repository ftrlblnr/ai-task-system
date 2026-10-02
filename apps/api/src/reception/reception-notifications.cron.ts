import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';

// Раздел 10.2/14 ТЗ «Приёмная»: durable outbox, первая попытка не позднее
// 5 секунд после commit — опрос каждые 5 секунд (CronExpression.
// EVERY_5_SECONDS ниже), не 10 минут, как у остальных cron'ов проекта: для
// почты/календаря такая задержка приемлема, для "руководитель вас вызывает
// прямо сейчас" — нет.
const BATCH_SIZE = 20;
// Короткий TTL блокировки (раздел 11.4 ТЗ) — упавший между claim'ом и
// отправкой воркер не держит запись дольше, чем следующий тик другого
// воркера сможет её перехватить.
const LOCK_TTL_MS = 30 * 1000;
// Раздел 10.2 ТЗ: "до трёх автоматических повторов через 10, 30 и 120
// секунд" — задержки последовательные (между соседними попытками), не все
// от первой попытки; после исчерпания — FAILED.
const RETRY_DELAYS_MS = [10_000, 30_000, 120_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

const MESSAGE_SELECT = {
  id: true,
  kind: true,
  attemptCount: true,
  request: { select: { title: true, rejectionReason: true } },
  recipient: { select: { telegramId: true } },
} satisfies Prisma.ReceptionNotificationSelect;

type ClaimedNotification = Prisma.ReceptionNotificationGetPayload<{ select: typeof MESSAGE_SELECT }>;

// Раздел 10.1 ТЗ — тексты сообщений дословно; "темы и причины экранируются/
// передаются без интерпретации разметки" выполняется тем, что мы НЕ
// передаём parse_mode в Bot API (TelegramBotService.sendMessageWithResult) —
// Telegram по умолчанию шлёт как plain text, Markdown/HTML не парсится.
function buildMessageText(n: ClaimedNotification): string {
  const title = n.request.title;
  switch (n.kind) {
    case 'CALLED':
      return `Руководитель приглашает вас по вопросу „${title}“. Подойдите к ней.`;
    case 'REJECTED':
      return n.request.rejectionReason
        ? `Ваше обращение „${title}“ отклонено. Причина: ${n.request.rejectionReason}`
        : `Ваше обращение „${title}“ отклонено.`;
    case 'RETURNED_TO_QUEUE':
      return `Вызов по вопросу „${title}“ отменён. Вопрос возвращён в очередь; ожидайте нового вызова.`;
  }
}

@Injectable()
export class ReceptionNotificationsCron {
  private readonly logger = new Logger(ReceptionNotificationsCron.name);
  // Идентификатор ЭТОГО процесса-воркера — только для читаемости
  // lockedBy в БД при отладке зависшего claim'а, на корректность не влияет
  // (единственный источник правды — lockedAt/TTL, не кто именно держит лок).
  private readonly workerId = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async processPending(): Promise<void> {
    const claimed = await this.claimBatch();
    for (const notification of claimed) {
      await this.deliver(notification);
    }
  }

  // Атомарный захват партии (раздел 11.4 ТЗ: "worker на PostgreSQL с
  // атомарным захватом записей") — SELECT ... FOR UPDATE SKIP LOCKED внутри
  // транзакции: конкурентный воркер (если их когда-нибудь станет больше
  // одного) пропускает уже захваченные строки, не ждёт и не дублирует
  // отправку.
  private async claimBatch(): Promise<ClaimedNotification[]> {
    const now = new Date();
    const lockThreshold = new Date(now.getTime() - LOCK_TTL_MS);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "ReceptionNotification"
          WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now} AND ("lockedAt" IS NULL OR "lockedAt" < ${lockThreshold})
          ORDER BY "createdAt" ASC
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED`,
      );
      if (locked.length === 0) return [];
      const ids = locked.map((r) => r.id);
      await tx.receptionNotification.updateMany({
        where: { id: { in: ids }, status: 'PENDING' },
        data: { lockedAt: now, lockedBy: this.workerId },
      });
      return tx.receptionNotification.findMany({ where: { id: { in: ids } }, select: MESSAGE_SELECT });
    });
  }

  private async deliver(notification: ClaimedNotification): Promise<void> {
    const text = buildMessageText(notification);
    const result = await this.bot.sendMessageWithResult(notification.recipient.telegramId, text);
    const attemptCount = notification.attemptCount + 1;

    if (result.ok) {
      await this.prisma.receptionNotification.update({
        where: { id: notification.id },
        data: { status: 'SENT', attemptCount, sentAt: new Date(), providerMessageId: String(result.messageId), lockedAt: null, lockedBy: null },
      });
      return;
    }

    // Раздел 10.2 ТЗ: без привязанного Telegram или без настройки бота —
    // SKIPPED, это не временная ошибка, ретраить нечего.
    if (result.reason === 'NO_TELEGRAM_ID' || result.reason === 'NOT_CONFIGURED') {
      await this.prisma.receptionNotification.update({
        where: { id: notification.id },
        data: { status: 'SKIPPED', attemptCount, lastErrorCode: result.reason, lockedAt: null, lockedBy: null },
      });
      return;
    }

    if (attemptCount >= MAX_ATTEMPTS) {
      await this.prisma.receptionNotification.update({
        where: { id: notification.id },
        data: { status: 'FAILED', attemptCount, lastErrorCode: result.reason, lockedAt: null, lockedBy: null },
      });
      this.logger.warn(`reception notification ${notification.id} исчерпала попытки: ${result.reason} ${result.detail}`);
      return;
    }

    const delayMs = RETRY_DELAYS_MS[attemptCount - 1];
    await this.prisma.receptionNotification.update({
      where: { id: notification.id },
      data: {
        status: 'PENDING',
        attemptCount,
        lastErrorCode: result.reason,
        nextAttemptAt: new Date(Date.now() + delayMs),
        lockedAt: null,
        lockedBy: null,
      },
    });
  }
}

export { RETRY_DELAYS_MS, MAX_ATTEMPTS, buildMessageText };

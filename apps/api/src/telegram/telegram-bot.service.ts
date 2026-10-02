import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Раздел 13 ТЗ «Приёмная»: sendMessage() ниже возвращает void и подавляет
// любую ошибку — её best-effort поведение нужно остальным модулям
// (создание задачи, смена статуса и т.п.) и сохраняется как есть. Приёмной
// нужен ОТДЕЛЬНЫЙ метод с типизированным результатом доставки — durable
// outbox (ReceptionNotification) сам решает, что значит каждый исход
// (SKIPPED — не ретраим вообще, HTTP/сетевая ошибка — ретраим по графику).
// NOT_CONFIGURED/NO_TELEGRAM_ID — не ошибки сервиса, а причина не слать
// вовсе, различать их должен вызывающий outbox-воркер, не эта функция.
export type TelegramDeliveryResult =
  | { ok: true; messageId: number }
  | { ok: false; reason: 'NO_TELEGRAM_ID' | 'NOT_CONFIGURED' | 'HTTP_ERROR' | 'NETWORK_ERROR'; detail: string };

// Только исходящие сообщения (push-уведомления) — не путать с
// TelegramService, который занимается входящей привязкой/авторизацией.
// Прямой fetch на Bot API, без SDK: нужен ровно один метод, отдельная
// библиотека была бы избыточна для одного вызова.
@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);

  constructor(private readonly config: ConfigService) {}

  // Best-effort и никогда не бросает — вызывающий код (создание задачи,
  // смена статуса и т.п.) не должен падать из-за недоступности Telegram
  // или отсутствия у сотрудника привязанного аккаунта (тот же принцип,
  // что у AuditService.log и GoogleCalendarSyncService.pushBestEffort).
  async sendMessage(telegramId: string | null | undefined, text: string): Promise<void> {
    if (!telegramId) return;

    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return;

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramId, text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`Telegram sendMessage не удался (${res.status}) для ${telegramId}: ${body}`);
      }
    } catch (err) {
      this.logger.warn(`Telegram sendMessage упал для ${telegramId}: ${err}`);
    }
  }

  // Раздел 10.2 ТЗ «Приёмная» — та же отправка, но с результатом, по
  // которому outbox-воркер (reception-notifications.cron.ts) ведёт
  // attemptCount/nextAttemptAt/status, а не глотает исход молча.
  async sendMessageWithResult(telegramId: string | null | undefined, text: string): Promise<TelegramDeliveryResult> {
    if (!telegramId) return { ok: false, reason: 'NO_TELEGRAM_ID', detail: 'у сотрудника не привязан Telegram' };

    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return { ok: false, reason: 'NOT_CONFIGURED', detail: 'TELEGRAM_BOT_TOKEN не настроен' };

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramId, text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, reason: 'HTTP_ERROR', detail: `${res.status}: ${body}`.slice(0, 500) };
      }
      const json = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
      return { ok: true, messageId: json?.result?.message_id ?? 0 };
    } catch (err) {
      return { ok: false, reason: 'NETWORK_ERROR', detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

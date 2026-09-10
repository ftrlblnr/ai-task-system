import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
}

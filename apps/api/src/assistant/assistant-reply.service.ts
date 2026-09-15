import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

// Обычный (без tool use) диалоговый ответ ассистента — Phase B Stage 2:
// только персист + текст, никакого доступа к реальным Task/Event данным.
// Tool-calling (получить реальные задачи/события и отрендерить карточки) —
// отдельный, более поздний этап (Stage 2, Phase C), см. план. Модель здесь
// сознательно НЕ каскад Haiku→Opus, как в voice — это отдельный, независимый
// путь использования Anthropic, трогать draft-extraction.service.ts (голос)
// этот файл не должен и не будет.
const REPLY_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Ты — ассистент корпоративной системы задач «Адъютант».
Сейчас у тебя ЕЩЁ НЕТ доступа к реальным задачам, встречам или календарю
пользователя — эта возможность скоро появится. Если пользователь спрашивает
про свои конкретные задачи, встречи, сроки или коллег — не выдумывай ответ и
не притворяйся, что видишь эти данные. Честно скажи, что пока не имеешь
доступа к этой информации, но скоро это заработает. На общие вопросы и
обычный диалог отвечай нормально, дружелюбно, по-русски, без markdown-разметки
крупнее обычного форматирования (заголовки/списки/жирный текст — можно).`;

export interface ReplyHistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

@Injectable()
export class AssistantReplyService {
  private readonly logger = new Logger(AssistantReplyService.name);
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  // Ленивая инициализация — тот же приём, что WhisperService/
  // DraftExtractionService: отсутствие ANTHROPIC_API_KEY не должно ронять
  // весь процесс при старте, только эту функцию при первом обращении.
  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  async reply(text: string, history: ReplyHistoryItem[]): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user' as const, content: text },
    ];

    const response = await this.getClient().messages.create({
      model: REPLY_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!block) {
      this.logger.warn('Ответ Anthropic не содержит текстового блока');
      return 'Не удалось сформировать ответ, попробуйте ещё раз.';
    }
    return block.text;
  }
}

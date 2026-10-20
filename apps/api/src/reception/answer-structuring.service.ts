import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

// Голосовой ответ руководителя (владелец 20.10.2026: «только
// структурированный текст») — сырой текст Whisper приводится к аккуратному
// деловому ответу: пунктуация, без слов-паразитов и повторов, несколько
// поручений — нумерованным списком. Аудио не хранится и не пересылается.
// Haiku: задача — редактура, не рассуждение (тот же выбор, что
// trips/trip-extraction.service.ts).
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Ты редактируешь ответ руководителя сотруднику. Руководитель надиктовал ответ голосом, текст получен распознаванием речи и может содержать ошибки распознавания, слова-паразиты, повторы и оговорки.

Перепиши его в аккуратный деловой ответ:
- исправь пунктуацию и очевидные ошибки распознавания;
- убери слова-паразиты, повторы и оговорки («э-э», «короче», «ну вот», «то есть нет»);
- сохрани смысл, тон и все конкретные факты: суммы, даты, сроки, имена, названия — ничего не добавляй от себя и не смягчай решение;
- если в ответе несколько поручений или пунктов — оформи нумерованным списком (1. 2. 3.), иначе — одним-двумя абзацами;
- пиши от лица руководителя, без приветствия и подписи;
- обычный текст без разметки Markdown (без **, #, _), текст уйдёт в Telegram как есть.

Верни только итоговый текст ответа, без пояснений.`;

@Injectable()
export class AnswerStructuringService {
  private readonly logger = new Logger(AnswerStructuringService.name);
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  // Не удалось — возвращается сырой текст: руководитель всё равно видит и
  // правит его перед отправкой.
  async structure(raw: string, question?: { title: string; description: string }): Promise<string> {
    const context = question ? `Вопрос сотрудника: «${question.title}»\n${question.description}\n\n` : '';
    try {
      const response = await this.getClient().messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `${context}Надиктованный ответ руководителя:\n${raw}` }],
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      return text || raw;
    } catch (err) {
      this.logger.warn(`answer structuring failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return raw;
    }
  }
}

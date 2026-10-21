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

// Прод 21.10.2026: на мусорном транскрипте модель отвечала комментарием
// («надиктованный ответ не полный…») или сочиняла ответ по теме вопроса.
// Поэтому — forced tool с явным вариантом «ответа нет» и запрет добавлять
// что-либо, чего руководитель не сказал.
const SYSTEM_PROMPT = `Ты редактор, а не автор. Руководитель надиктовал ответ сотруднику голосом, текст получен распознаванием речи и может содержать ошибки распознавания, слова-паразиты, повторы и оговорки.

Приведи текст в порядок:
- исправь пунктуацию и очевидные ошибки распознавания;
- убери слова-паразиты, повторы и оговорки («э-э», «короче», «ну вот», «то есть нет»);
- если в ответе несколько поручений или пунктов — оформи нумерованным списком (1. 2. 3.), иначе — одним-двумя абзацами;
- пиши от лица руководителя, без приветствия и подписи, обычным текстом без Markdown.

Строго запрещено:
- добавлять решения, поручения, факты, сроки и детали, которых нет в надиктованном тексте — даже если они логично следуют из вопроса;
- менять смысл, смягчать или усиливать решение;
- обращаться к пользователю, комментировать качество записи или просить уточнений.

Короткий ответ («да», «нет», «согласовано», «не сейчас») — полноценный ответ, верни его с заглавной буквы и точкой.

Вопрос сотрудника дан только для того, чтобы правильно написать термины и имена — не для того, чтобы дописать ответ.

Если в надиктованном тексте нет осмысленного ответа (пусто, обрывок, шум, фразы вроде «Продолжение следует», «Субтитры…», не относящиеся к делу), вызови инструмент с has_answer = false.`;

const TOOL: Anthropic.Tool = {
  name: 'submit_answer',
  description: 'Вернуть отредактированный ответ руководителя',
  input_schema: {
    type: 'object',
    properties: {
      has_answer: { type: 'boolean', description: 'false — в надиктованном нет осмысленного ответа' },
      text: { type: 'string', description: 'Отредактированный ответ; пустая строка, если has_answer = false' },
    },
    required: ['has_answer', 'text'],
  },
};

// Редактура сокращает или почти не меняет длину — заметно более длинный
// результат означает, что модель дописала от себя.
function looksInvented(raw: string, edited: string): boolean {
  return edited.length > raw.length * 1.6 + 60;
}

// Короткий ответ редактировать нечего — модель только мешает (на «да» она
// решала, что ответа нет).
const SHORT_ANSWER_WORDS = 3;

function tidyShort(raw: string): string {
  const text = raw.trim().replace(/\s+/g, ' ');
  const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?…]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

export type StructuringResult = { kind: 'answer'; text: string } | { kind: 'no_answer' };

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

  // Сбой модели — сырой текст: руководитель всё равно видит и правит его
  // перед отправкой.
  async structure(raw: string, question?: { title: string; description: string }): Promise<StructuringResult> {
    if (raw.trim().split(/\s+/).length <= SHORT_ANSWER_WORDS) return { kind: 'answer', text: tidyShort(raw) };
    const context = question ? `Вопрос сотрудника (только для терминов): «${question.title}»\n${question.description}\n\n` : '';
    try {
      const response = await this.getClient().messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content: `${context}Надиктованный текст:\n${raw}` }],
      });
      const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (!block) throw new Error('no tool_use block in response');
      const input = block.input as { has_answer?: boolean; text?: string };
      const text = (input.text ?? '').trim();
      if (input.has_answer === false) return { kind: 'no_answer' };
      if (!text) return { kind: 'answer', text: raw };
      if (looksInvented(raw, text)) {
        this.logger.warn(`answer structuring discarded: output ${text.length} chars vs raw ${raw.length}`);
        return { kind: 'answer', text: raw };
      }
      return { kind: 'answer', text };
    } catch (err) {
      this.logger.warn(`answer structuring failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return { kind: 'answer', text: raw };
    }
  }
}

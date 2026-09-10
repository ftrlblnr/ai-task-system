import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

// Наивная regex-замена "Speaker N" -> имя ломает русские падежи ("по
// мнению Speaker 2" -> "по мнению Иван" вместо "Ивана") — владелец
// 09.09.2026 указал на это после первого прогона. Вместо словаря склонений
// (который не решает задачу — нужно ещё понять, какой падеж нужен по
// контексту предложения) прогоняем через Claude: он и понимает контекст, и
// склоняет корректно.
const MODEL = 'claude-opus-5';

@Injectable()
export class SpeakerSubstitutionService {
  private client: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  async substitute(rawSummary: string, speakerNames: Record<string, string>): Promise<string> {
    const mapping = Object.entries(speakerNames)
      .map(([label, name]) => `- ${label} -> ${name}`)
      .join('\n');

    const system = `Тебе дан текст саммари встречи на русском языке, где вместо имён участников используются метки вида "Speaker 1", "Speaker 2" и т.д. Замени каждое упоминание метки на указанное имя, СКЛОНЁННОЕ по правильному падежу для контекста этого конкретного места в предложении (именительный/родительный/дательный/винительный/творительный/предложный — по грамматике окружающего текста), а не всегда в именительном падеже.

Сопоставление меток именам:
${mapping}

КРИТИЧЕСКИ ВАЖНО: верни ВЕСЬ текст целиком, без единого изменения где-либо, кроме самих меток спикеров — та же markdown-разметка, тот же HTML (включая теги вроде <mark>), та же пунктуация, тот же порядок, ничего не сокращай и не перефразируй. Единственное разрешённое изменение — замена меток спикеров на склонённые имена. Если метка встречается в позиции, где падеж неочевиден (например, в заголовке списком) — используй именительный падеж по умолчанию. Меток, которых нет в списке сопоставления выше, не трогай вообще.

Вызови инструмент substitute ровно один раз с результатом.`;

    const response = await this.getClient().messages.create({
      model: MODEL,
      max_tokens: 8192,
      system,
      tools: [
        {
          name: 'substitute',
          description: 'Вернуть текст саммари с заменёнными и склонёнными именами спикеров.',
          strict: true,
          input_schema: {
            type: 'object',
            properties: { result: { type: 'string' } },
            required: ['result'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'substitute' },
      messages: [{ role: 'user', content: rawSummary }],
    });

    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!block) {
      throw new InternalServerErrorException('Claude не вернул обработанный текст саммари');
    }

    return (block.input as { result: string }).result;
  }
}

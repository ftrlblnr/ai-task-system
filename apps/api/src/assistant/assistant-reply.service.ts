import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantToolsService, type ToolExecutionResult } from './assistant-tools.service';

// Диалоговый ответ ассистента — Stage 2. Phase B: обычный (без tool use)
// вызов. Phase C: один раунд tool use (LLM решает вызвать get_tasks/
// get_events → реальные данные → бэкенд сам рисует карточки, см.
// assistant-render.ts) — НЕ рекурсивный agentic loop (спека §33 запрещает
// multi-agent на этом этапе): если после результата инструмента модель
// снова просит инструмент, второй раунд не выполняется, берём текст как
// есть. Модель здесь сознательно НЕ каскад Haiku→Opus, как в voice — это
// отдельный, независимый путь использования Anthropic, draft-extraction.
// service.ts (голос) не трогается и не участвует.
const REPLY_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Ты — ассистент корпоративной системы задач «Адъютант».
У тебя есть инструменты для получения РЕАЛЬНЫХ задач и (если доступно)
встреч пользователя — вызывай их, когда пользователь спрашивает про свои
конкретные задачи, сроки, просрочки или встречи. Никогда не выдумывай
задачи, встречи, сроки или имена коллег — если инструмент недоступен или
вернул ошибку, честно скажи об этом, не притворяйся, что видишь данные.
На общие вопросы и обычный диалог отвечай нормально, дружелюбно,
по-русски, без markdown-разметки крупнее обычного форматирования
(заголовки/списки/жирный текст — можно). Список задач/встреч в карточках
после твоего ответа отрендерит сам интерфейс — не перечисляй их ещё раз
подробно текстом, достаточно короткого комментария.`;

export interface ReplyHistoryItem {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantReplyResult {
  text: string;
  toolCalls: { name: string; result: ToolExecutionResult }[];
}

@Injectable()
export class AssistantReplyService {
  private readonly logger = new Logger(AssistantReplyService.name);
  private client: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly tools: AssistantToolsService,
  ) {}

  // Ленивая инициализация — тот же приём, что WhisperService/
  // DraftExtractionService: отсутствие ANTHROPIC_API_KEY не должно ронять
  // весь процесс при старте, только эту функцию при первом обращении.
  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.client;
  }

  async reply(text: string, history: ReplyHistoryItem[], user: AuthenticatedUser): Promise<AssistantReplyResult> {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user' as const, content: text },
    ];
    const tools = this.tools.buildTools(user);

    const first = await this.getClient().messages.create({
      model: REPLY_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      tool_choice: { type: 'auto' },
      messages,
    });

    const toolUseBlocks = first.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      return { text: this.extractText(first.content), toolCalls: [] };
    }

    const toolCalls: { name: string; result: ToolExecutionResult }[] = [];
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const result = await this.tools.execute(block.name, block.input, user);
      toolCalls.push({ name: block.name, result });
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify('error' in result ? { error: result.message } : result),
        is_error: 'error' in result,
      });
    }

    const second = await this.getClient().messages.create({
      model: REPLY_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages: [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: toolResultBlocks }],
    });

    // Один раунд tool use — сознательно не зацикливаемся, если модель
    // просит инструмент повторно (см. комментарий у класса выше).
    if (second.content.some((b) => b.type === 'tool_use')) {
      this.logger.warn('Модель запросила ещё один раунд tool use — второй раунд не поддерживается, беру текст как есть');
    }

    return { text: this.extractText(second.content), toolCalls };
  }

  private extractText(content: Anthropic.ContentBlock[]): string {
    const block = content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!block) {
      this.logger.warn('Ответ Anthropic не содержит текстового блока');
      return 'Не удалось сформировать ответ, попробуйте ещё раз.';
    }
    return block.text;
  }
}

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
// есть. Phase E: тот же tool loop, но через messages.stream() вместо
// messages.create() — runReply() отдаёт прогресс через необязательный
// onEvent, reply()/streamReply() — тонкие обёртки над одной и той же
// логикой (не дублировать tool loop в двух местах). Модель здесь
// сознательно НЕ каскад Haiku→Opus, как в voice — это отдельный,
// независимый путь использования Anthropic, draft-extraction.service.ts
// (голос) не трогается и не участвует.
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
  // durationMs — Phase F.1 (observability, аудит 16.09.2026): позволяет
  // AssistantChatService посчитать toolExecutionMs без отдельного канала
  // передачи тайминга через onEvent — итоговый AssistantReplyResult уже
  // несёт всё нужное, для sendMessage (без колбэка вообще) это единственный
  // способ узнать время инструментов.
  toolCalls: { name: string; result: ToolExecutionResult; durationMs: number }[];
}

// Прогресс streamReply() — только текст/инструменты, ничего про
// messageId/partId (это знает вызывающий AssistantChatService, не этот
// сервис). text-reset — сигнал "начинается новый раунд текста, накопленное
// раньше нужно отбросить": редкий случай, когда модель до вызова
// инструмента успела начать отвечать текстом (см. план Phase E) — этот же
// сигнал шлётся и перед самым первым раундом, вызывающий код просто
// сбрасывает накопитель в обоих случаях одинаково.
export type ReplyStreamEvent =
  | { type: 'text-reset' }
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-started'; name: string }
  | { type: 'tool-completed'; name: string; result: ToolExecutionResult };

export type ReplyStreamListener = (event: ReplyStreamEvent) => void;

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
    return this.runReply(text, history, user);
  }

  // signal — обрыв соединения с клиентом (AssistantChatService слушает
  // res.on('close')) должен прервать реальный HTTP-запрос к Anthropic, а не
  // продолжать платить за токены, которые уже некому показать.
  async streamReply(
    text: string,
    history: ReplyHistoryItem[],
    user: AuthenticatedUser,
    onEvent: ReplyStreamListener,
    signal?: AbortSignal,
  ): Promise<AssistantReplyResult> {
    return this.runReply(text, history, user, onEvent, signal);
  }

  private async runReply(
    text: string,
    history: ReplyHistoryItem[],
    user: AuthenticatedUser,
    onEvent?: ReplyStreamListener,
    signal?: AbortSignal,
  ): Promise<AssistantReplyResult> {
    const messages: Anthropic.MessageParam[] = [
      ...history.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user' as const, content: text },
    ];
    const tools = this.tools.buildTools(user);

    onEvent?.({ type: 'text-reset' });
    const first = await this.streamOnce(messages, tools, onEvent, signal);

    const toolUseBlocks = first.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      return { text: this.extractText(first.content), toolCalls: [] };
    }

    const toolCalls: AssistantReplyResult['toolCalls'] = [];
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      onEvent?.({ type: 'tool-started', name: block.name });
      const toolStart = Date.now();
      const result = await this.tools.execute(block.name, block.input, user);
      const durationMs = Date.now() - toolStart;
      toolCalls.push({ name: block.name, result, durationMs });
      onEvent?.({ type: 'tool-completed', name: block.name, result });
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify('error' in result ? { error: result.message } : result),
        is_error: 'error' in result,
      });
    }

    // Раунд 1 не мог быть финальным ответом (были tool_use) — сбрасываем
    // то, что могло успеть настримиться текстом до/вперемешку с tool_use,
    // и начинаем текст раунда 2 с чистого накопителя (см. комментарий у
    // ReplyStreamEvent выше).
    onEvent?.({ type: 'text-reset' });
    const second = await this.streamOnce(
      [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: toolResultBlocks }],
      tools,
      onEvent,
      signal,
    );

    // Один раунд tool use — сознательно не зацикливаемся, если модель
    // просит инструмент повторно (см. комментарий у класса выше).
    if (second.content.some((b) => b.type === 'tool_use')) {
      this.logger.warn('Модель запросила ещё один раунд tool use — второй раунд не поддерживается, беру текст как есть');
    }

    return { text: this.extractText(second.content), toolCalls };
  }

  private async streamOnce(
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
    onEvent: ReplyStreamListener | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Anthropic.Message> {
    const stream = this.getClient().messages.stream(
      {
        model: REPLY_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        tool_choice: { type: 'auto' },
        messages,
      },
      { signal },
    );
    if (onEvent) {
      stream.on('text', (delta) => onEvent({ type: 'text-delta', delta }));
    }
    return stream.finalMessage();
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

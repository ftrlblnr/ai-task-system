import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { nowInLocalTimezone } from '../common/timezone';
import { AssistantToolsService, isWriteTool, type ToolExecutionResult } from './assistant-tools.service';

// Диалоговый ответ ассистента — Stage 2. Phase B: обычный (без tool use)
// вызов. Phase C: один раунд tool use (LLM решает вызвать get_tasks/
// get_events → реальные данные → бэкенд сам рисует карточки, см.
// assistant-render.ts). Phase E: тот же tool loop, но через
// messages.stream() вместо messages.create() — runReply() отдаёт прогресс
// через необязательный onEvent, reply()/streamReply() — тонкие обёртки над
// одной и той же логикой (не дублировать tool loop в двух местах). Модель
// здесь сознательно НЕ каскад Haiku→Opus, как в voice — это отдельный,
// независимый путь использования Anthropic, draft-extraction.service.ts
// (голос) не трогается и не участвует.
//
// MAX_TOOL_ROUNDS (Stage 2, Phase L, находка №5 пятого внешнего аудита,
// 21.09.2026, P1) — раньше был жёстко один раунд tool use, не
// рекурсивный agentic loop (спека §33 запрещает multi-agent на этом
// этапе). Это блокировало естественные многошаговые вопросы про Plaud-
// встречи (Phase K), например "найди встречу с Петром на прошлой неделе и
// процитируй, что он сказал про сроки" — требует get_recent_meetings,
// затем search_meeting_transcript по её id, т.е. минимум два
// последовательных вызова инструментов. Ограниченный цикл (не безусловная
// рекурсия) — не agentic loop в смысле §33 (нет автономного планирования
// между произвольными инструментами/агентами, нет само-порождённых
// подзадач): та же модель, тот же system-промпт, тот же список
// инструментов на каждом раунде, просто до 3 раундов вместо 1 — числовой
// потолок предотвращает патологическое зацикливание модели.
const MAX_TOOL_ROUNDS = 3;

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
подробно текстом, достаточно короткого комментария. В истории разговора
ранее показанные задачи/встречи/файлы отмечены служебными пометками вида
"[shown_task]", "[shown_event]", "[file]" с техническими полями (id,
mimeType и т.п.) — это внутреннее представление для тебя, пользователь их
никогда не видел и не должен видеть; никогда не копируй такие пометки или
их формат в свой ответ, ссылайся на задачи/встречи/файлы обычным текстом
(по названию). Текущее сообщение пользователя тоже может содержать
похожую пометку "[attached_file]" — это метаданные файла, который
пользователь только что прикрепил (у тебя нет доступа к содержимому
файла, только имя/тип/размер) — используй её, чтобы понять, что
пользователь прислал файл, но точно так же никогда не копируй саму
пометку в ответ. Иногда перед текущим сообщением стоит блок
"[live_context]…[/live_context]" — это недавний ГОЛОСОВОЙ разговор
пользователя с голосовым ассистентом (реплики "User:"/"Assistant:"), которого
нет в истории переписки; используй его, чтобы понять "из этого", "ему", "там",
"второй пункт", "эта встреча", но не цитируй его и не копируй блок в ответ.
Если пользователь снова просит выгрузить/прислать файл —
всегда вызывай export_tasks_xlsx заново, даже если похожий файл уже
формировался раньше в этом же разговоре: у каждой твоей реплики может не
быть собственного вложения, и утверждать "файл готов" в тексте, реально
не вызвав инструмент, оставит пользователя без файла для скачивания.`;

// Живая проверка (16.09.2026, Phase G) показала, что инструкции в
// SYSTEM_PROMPT одни не всегда надёжны: модель (особенно быстрый Haiku)
// иногда всё равно дословно копирует служебный формат "[shown_task]/
// [shown_event]/[file]\nkey=value..." из истории разговора в собственный
// ответ — сильная имитация формата, который она только что видела в
// контексте, перевешивает текстовую инструкцию не делать этого. Не
// полагаемся только на просьбу к модели — детерминированная зачистка
// после генерации гарантирует, что утечка не попадёт в сохранённое
// сообщение, даже если модель проигнорирует инструкцию. Ловит только эти
// четыре конкретных тега (serializeMessageForModelContext/
// serializeCurrentUserTurn, assistant-chat.service.ts) — не трогает
// случайное непохожее использование квадратных скобок в обычном тексте
// ответа. attached_file добавлен в Phase F.2 вместе с самим тегом — та же
// утечка, тот же риск, закрыта сразу, а не после повторного живого прогона.
const LEAKED_CONTEXT_MARKER = /\[(?:shown_task|shown_event|file|attached_file)\]\n(?:[a-zA-Z]+=[^\n]*\n?)+/g;

// Stage 2, Phase Q hardening — блок [live_context]…[/live_context] (недавний
// голосовой разговор GPT-Live, см. serializeCurrentUserTurn) — тот же риск
// утечки формата в ответ модели, закрыт сразу вместе с самим блоком.
const LEAKED_LIVE_CONTEXT_BLOCK = /\[live_context\][\s\S]*?\[\/live_context\]/g;

export function stripLeakedContextMarkers(text: string): string {
  return text.replace(LEAKED_CONTEXT_MARKER, '').replace(LEAKED_LIVE_CONTEXT_BLOCK, '').trim();
}

// Stage 2, Phase O (Meeting → Task workflow, 22.09.2026) — до этого этапа
// SYSTEM_PROMPT вообще не содержал текущей даты/времени (в отличие от
// voice — draft-extraction.service.ts, где ${nowIso} уже используется для
// разрешения "завтра"/"в пятницу"). create_task_from_meeting.dueDate
// требует того же — не заводим новый парсер дат, переиспользуем ровно ту
// же формулировку и источник (nowInLocalTimezone(), common/timezone.ts).
// Отдельная функция, не статичная строка в SYSTEM_PROMPT — nowIso должен
// быть свежим на момент вызова, не захардкожен при старте процесса.
export function buildDateContext(): string {
  return `Текущие дата и время — уже по местному времени пользователя (Казахстан, UTC+5), используй как есть для разрешения относительных выражений вроде "завтра", "в пятницу", "через час": ${nowInLocalTimezone()}

Поле dueDate инструмента create_task_from_meeting заполняй ТОЖЕ по этому же местному времени, БЕЗ суффикса Z и без смещения часового пояса (просто "2026-09-02T13:00:00") — часовой пояс сервер подставит сам.`;
}

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

  async reply(
    text: string,
    history: ReplyHistoryItem[],
    user: AuthenticatedUser,
    conversationId: string,
    userMessageId: string,
  ): Promise<AssistantReplyResult> {
    return this.runReply(text, history, user, conversationId, userMessageId);
  }

  // signal — обрыв соединения с клиентом (AssistantChatService слушает
  // res.on('close')) должен прервать реальный HTTP-запрос к Anthropic, а не
  // продолжать платить за токены, которые уже некому показать.
  async streamReply(
    text: string,
    history: ReplyHistoryItem[],
    user: AuthenticatedUser,
    conversationId: string,
    userMessageId: string,
    onEvent: ReplyStreamListener,
    signal?: AbortSignal,
  ): Promise<AssistantReplyResult> {
    return this.runReply(text, history, user, conversationId, userMessageId, onEvent, signal);
  }

  // Stage 2, Phase O (Meeting → Task workflow, 22.09.2026) — conversationId/
  // userMessageId прокинуты сюда только ради write-tool'ов
  // (create_task_from_meeting): read-only тулы их игнорируют, но
  // AssistantToolsService.execute нужна стабильная, переживающая ретрай
  // пара (conversationId, userMessageId) для idempotency-claim'а — она уже
  // существует к этому моменту (userMessage создан/переиспользован ДО
  // вызова reply()/streamReply(), см. AssistantChatService), в отличие от
  // tool_use.id от Anthropic, который при полном ретрае runReply (новый
  // вызов Claude) каждый раз новый — не годится как ключ идемпотентности.
  private async runReply(
    text: string,
    history: ReplyHistoryItem[],
    user: AuthenticatedUser,
    conversationId: string,
    userMessageId: string,
    onEvent?: ReplyStreamListener,
    signal?: AbortSignal,
  ): Promise<AssistantReplyResult> {
    let messages: Anthropic.MessageParam[] = [
      ...history.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user' as const, content: text },
    ];
    const tools = await this.tools.buildTools(user);
    const toolCalls: AssistantReplyResult['toolCalls'] = [];
    // Hardening-раунд Phase O (22.09.2026, P0/P1 "stable tool
    // idempotency"), уточнено roadmap v13 MUST-FIX #2 (23.09.2026) —
    // счётчик на ВЕСЬ вызов runReply, не сбрасывается между раундами, НО
    // растёт только на write-tool'ах (isWriteTool, сейчас только
    // create_task_from_meeting) — read-tool'ы (search_meetings/get_meeting/
    // search_meeting_transcript/...) его не двигают. Раньше счётчик рос на
    // КАЖДОМ tool-вызове без разбора — ретрай с другим числом read-вызовов
    // перед тем же write-вызовом получал другой индекс → другой dedupeKey →
    // защита от дублей не срабатывала. create_task_from_meeting строит
    // dedupeKey из (userMessageId, writeToolCallIndex) — не из meetingId/
    // title (LLM-текст), см. её комментарий. Позиционная identity среди
    // write-вызовов: тот же порядок write-вызовов при полном ретрае даёт
    // тот же индекс на том же логическом действии (переживает и
    // перефразирование title моделью, и разное число read-вызовов вокруг),
    // а два РАЗНЫХ write-вызова в одном ответе (например, одна и та же
    // формулировка для двух разных исполнителей) получают разные индексы —
    // не схлопываются в один.
    let writeToolCallIndex = 0;

    onEvent?.({ type: 'text-reset' });
    let response = await this.streamOnce(messages, tools, onEvent, signal);

    for (let round = 1; ; round++) {
      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUseBlocks.length === 0) {
        return { text: this.extractText(response.content), toolCalls };
      }

      if (round > MAX_TOOL_ROUNDS) {
        // Потолок раундов достигнут — сознательно не зацикливаемся дальше
        // (см. MAX_TOOL_ROUNDS выше), берём текст последнего ответа как
        // есть (обычно пустой, раз модель снова попросила инструмент —
        // extractText сам подставит нейтральный fallback).
        this.logger.warn(`Модель запросила ещё один раунд tool use сверх лимита (${MAX_TOOL_ROUNDS}) — беру текст как есть`);
        return { text: this.extractText(response.content), toolCalls };
      }

      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        onEvent?.({ type: 'tool-started', name: block.name });
        const toolStart = Date.now();
        const result = await this.tools.execute(
          block.name,
          block.input,
          user,
          conversationId,
          userMessageId,
          isWriteTool(block.name) ? writeToolCallIndex++ : undefined,
        );
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

      messages = [...messages, { role: 'assistant', content: response.content }, { role: 'user', content: toolResultBlocks }];

      // Этот раунд не мог быть финальным ответом (были tool_use) —
      // сбрасываем то, что могло успеть настримиться текстом до/вперемешку
      // с tool_use, и начинаем текст следующего раунда с чистого
      // накопителя (см. комментарий у ReplyStreamEvent выше).
      onEvent?.({ type: 'text-reset' });
      response = await this.streamOnce(messages, tools, onEvent, signal);
    }
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
        system: `${SYSTEM_PROMPT}\n\n${buildDateContext()}`,
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

  // Phase F.2 (аудит 17.09.2026, P2.12) — раньше брался только первый
  // TextBlock через .find(): Anthropic формально может вернуть несколько
  // text-блоков подряд (не только вперемешку с tool_use) — .find() тихо
  // терял всё, что шло после первого. Склеиваем все, тот же порядок, в
  // котором их прислал Anthropic.
  private extractText(content: Anthropic.ContentBlock[]): string {
    const blocks = content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    if (blocks.length === 0) {
      this.logger.warn('Ответ Anthropic не содержит текстового блока');
      return 'Не удалось сформировать ответ, попробуйте ещё раз.';
    }
    return stripLeakedContextMarkers(blocks.map((b) => b.text).join(''));
  }
}

import { BadGatewayException, Injectable, Logger, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantChatService } from '../assistant/assistant-chat.service';
import { VoiceService } from '../voice/voice.service';
import { CreateLiveSessionDto } from './dto/create-live-session.dto';
import { LiveTranscriptBuffer } from './live-transcript-buffer';
import { buildSessionInput, LIVE_INPUT_MAX_MESSAGES } from './live-session-input';
import { toSpokenLiveReply } from './live-spoken-reply';

// Stage 2, Phase Q (roadmap v13 "Phase O — GPT-Live/WebRTC", 24.09.2026).
// GPT-Live ведёт живой разговор голосом, а всё, что требует данных/действий,
// делегирует бэкенду (delegation.type = "client"). Бэкенд — это уже
// существующий Assistant Core: делегированная задача превращается в ОБЫЧНОЕ
// сообщение чата (AssistantChatService.sendMessage) — те же tools, RBAC,
// идемпотентность, запись в общую ленту, никакого нового слоя бизнес-логики.

const LIVE_API_URL = 'https://api.openai.com/v1/live/sessions';
const LIVE_ATTACH_URL = (sessionId: string) => `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`;

const DEFAULT_MODEL = 'gpt-live-1';
const DEFAULT_MAX_SESSION_MS = 10 * 60 * 1000;

// session.delegation.created не содержит текста запроса — он собирается из
// транскрипта, а транскрипт — фрагменты без границ ходов и без события done
// (доки), хвост может прийти ПОСЛЕ самого события. Вместо фиксированной паузы —
// адаптивное ожидание: команда готова, когда покрытие user-речи дошло до
// offset_ms делегации ('coverage') или новых user-дельт нет уже SETTLE_QUIET_MS
// ('quiet'); жёсткий потолок SETTLE_MAX_MS ('cap'). Это эвристика — связь
// offset_ms и start_ms доки не гарантируют, поэтому исход логируется.
export const SETTLE_QUIET_MS = 250;
export const SETTLE_MAX_MS = 2000;
const SETTLE_POLL_MS = 50;
// Браузер получает SDP только когда серверный наблюдатель (sideband) готов.
export const SIDEBAND_OPEN_TIMEOUT_MS = 4000;
const MAX_REQUEST_CHARS = 4000; // SendMessageDto.text
const FAILURE_COMMENTARY = 'Не удалось выполнить запрос, подробности в чате.';
const EMPTY_REQUEST_COMMENTARY = 'Не расслышал запрос, повторите, пожалуйста.';

// Короткая инструкция для Live-модели: разговорный стиль и КОГДА делегировать.
// Детальные правила, tools и бизнес-логика остаются на бэкенде (Assistant Core).
const LIVE_INSTRUCTIONS =
  'Ты голосовой ассистент руководителя в корпоративной системе задач. Говори по-русски, коротко и естественно, как в живом разговоре. ' +
  'Любой запрос про задачи, встречи, записи Plaud, календарь, сотрудников, файлы или создание чего-либо — делегируй бэкенду, сам данные не выдумывай. ' +
  'Не говори, что действие выполнено, пока бэкенд не вернул результат. Если бэкенд вернул результат — озвучь его своими словами, кратко.';

interface LiveSession {
  id: string;
  user: AuthenticatedUser;
  conversationId: string;
  socket: WebSocket;
  transcript: LiveTranscriptBuffer;
  lastUserDeltaAt: number;
  seenDelegations: Set<string>;
  queue: Promise<void>;
  unknownEventTypes: Set<string>;
  maxDurationTimer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  closed: boolean;
}

@Injectable()
export class LiveService implements OnModuleDestroy {
  private readonly logger = new Logger(LiveService.name);
  private readonly sessions = new Map<string, LiveSession>();
  private readonly sessionByEmployee = new Map<string, string>();

  constructor(
    private readonly config: ConfigService,
    private readonly assistantChat: AssistantChatService,
    private readonly voice: VoiceService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<string>('LIVE_VOICE_ENABLED') === 'true';
  }

  async createSession(user: AuthenticatedUser, dto: CreateLiveSessionDto): Promise<{ sessionId: string; sdp: string }> {
    if (!this.isEnabled()) throw new NotFoundException();

    // Владение проверяется ДО обращения к OpenAI (чужой разговор не тратит
    // биллинг и не раскрывает факт существования).
    let conversationId: string;
    if (dto.conversationId) {
      await this.assistantChat.assertOwnedConversation(user, dto.conversationId);
      conversationId = dto.conversationId;
    } else {
      conversationId = (await this.assistantChat.getOrCreatePrimaryConversation(user)).id;
    }

    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) throw new ServiceUnavailableException('Живой голос не настроен');

    // Биллинг GPT-Live — посекундный: одна живая сессия на сотрудника,
    // предыдущая (забытая вкладка) закрывается.
    const previous = this.sessionByEmployee.get(user.id);
    if (previous) this.closeSession(previous, 'replaced');

    // session.input — недавняя переписка этого разговора (только текст), чтобы
    // «Живой голос» продолжал диалог, а не начинал с нуля. Сбой чтения истории
    // не должен блокировать живой голос — тогда стартуем без неё.
    let sessionInput: ReturnType<typeof buildSessionInput> = [];
    try {
      sessionInput = buildSessionInput(await this.assistantChat.getRecentMessages(user, conversationId, LIVE_INPUT_MAX_MESSAGES));
    } catch (err) {
      this.logger.error(`live session.input history failed: ${err instanceof Error ? err.name : 'unknown'}`);
    }

    const response = await fetch(LIVE_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: this.config.get<string>('LIVE_MODEL') || DEFAULT_MODEL,
          instructions: LIVE_INSTRUCTIONS,
          ...(sessionInput.length > 0 ? { input: sessionInput } : {}),
          audio: { output: { voice: 'marin' } },
          delegation: { type: 'client' },
          // Браузер — untrusted: только закрыть сессию; ни append'ов, ни
          // команд модели. Серверные события — ровно то, что нужно для
          // субтитров и статуса.
          client: {
            data_channel: {
              allowed_client_events: ['session.close'],
              allowed_server_events: [
                { type: 'session.started' },
                { type: 'session.closed' },
                { type: 'session.input_transcript.delta' },
                { type: 'session.output_transcript.delta' },
                { type: 'session.delegation.created' },
              ],
            },
          },
        },
        transport: { type: 'webrtc', sdp: dto.sdp },
      }),
    });

    if (!response.ok) {
      this.logger.error(`live session create failed status=${response.status}`);
      throw new BadGatewayException('Не удалось запустить живой голос');
    }
    const json = (await response.json()) as { session?: { id?: unknown }; transport?: { sdp?: unknown } };
    const sessionId = json.session?.id;
    const answerSdp = json.transport?.sdp;
    if (typeof sessionId !== 'string' || typeof answerSdp !== 'string') {
      this.logger.error('live session create: неожиданная форма ответа');
      throw new BadGatewayException('Не удалось запустить живой голос');
    }

    const socket = new WebSocket(LIVE_ATTACH_URL(sessionId), { headers: { Authorization: `Bearer ${apiKey}` } });
    const session: LiveSession = {
      id: sessionId,
      user,
      conversationId,
      socket,
      transcript: new LiveTranscriptBuffer(),
      lastUserDeltaAt: 0,
      seenDelegations: new Set(),
      queue: Promise.resolve(),
      unknownEventTypes: new Set(),
      maxDurationTimer: null,
      startedAt: Date.now(),
      closed: false,
    };
    socket.on('message', (data) => this.onSocketMessage(session, data));
    socket.on('close', () => this.cleanup(session));
    socket.on('error', (err) => this.logger.error(`live sideband error session=${sessionId}: ${err instanceof Error ? err.name : 'unknown'}`));

    // Успешный ответ клиенту — только после того, как sideband реально открыт:
    // иначе пользователь может начать говорить раньше, чем серверный
    // слушатель готов, и первый голосовой ход потеряется.
    try {
      await this.waitForSidebandOpen(socket);
    } catch (err) {
      this.logger.error(`live sideband not ready session=${sessionId}: ${err instanceof Error ? err.message : 'unknown'}`);
      try {
        socket.close();
      } catch {
        // сокет уже мёртв
      }
      this.cleanup(session);
      await this.hangup(sessionId, apiKey);
      throw new BadGatewayException('Не удалось запустить живой голос');
    }

    // Пока ждали sideband, параллельный create того же сотрудника мог успеть
    // зарегистрироваться — закрываем его, чтобы не осталось двух живых сессий.
    const concurrent = this.sessionByEmployee.get(user.id);
    if (concurrent && concurrent !== sessionId) this.closeSession(concurrent, 'replaced');
    this.sessions.set(sessionId, session);
    this.sessionByEmployee.set(user.id, sessionId);

    const maxMs = Number(this.config.get<string>('LIVE_MAX_SESSION_MS')) || DEFAULT_MAX_SESSION_MS;
    session.maxDurationTimer = setTimeout(() => this.closeSession(sessionId, 'max-duration'), maxMs);

    return { sessionId, sdp: answerSdp };
  }

  private waitForSidebandOpen(socket: WebSocket): Promise<void> {
    if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('timeout')), SIDEBAND_OPEN_TIMEOUT_MS);
      const onOpen = () => finish();
      const onError = (err: Error) => finish(new Error(err.name || 'error'));
      const onClose = () => finish(new Error('closed'));
      const finish = (err?: Error) => {
        clearTimeout(timer);
        socket.off('open', onOpen);
        socket.off('error', onError);
        socket.off('close', onClose);
        if (err) reject(err);
        else resolve();
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  // Серверное закрытие сессии (REST) — fallback, когда sideband не открыт/мёртв
  // и session.close отправить некуда. Best-effort: ошибки только в лог (без тела).
  private async hangup(sessionId: string, apiKey: string | undefined): Promise<void> {
    if (!apiKey) return;
    try {
      const res = await fetch(`${LIVE_API_URL}/${encodeURIComponent(sessionId)}/hangup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) this.logger.error(`live hangup failed session=${sessionId} status=${res.status}`);
    } catch (err) {
      this.logger.error(`live hangup failed session=${sessionId}: ${err instanceof Error ? err.name : 'unknown'}`);
    }
  }

  // Только владелец; чужой/несуществующий id — молча ничего (идемпотентно, не
  // раскрываем существование чужой сессии).
  closeForUser(user: AuthenticatedUser, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.user.id !== user.id) return;
    this.closeSession(sessionId, 'client');
  }

  onModuleDestroy(): void {
    for (const id of [...this.sessions.keys()]) this.closeSession(id, 'shutdown');
  }

  private closeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.logger.log(`live session closing session=${sessionId} reason=${reason}`);
    const socketOpen = session.socket.readyState === WebSocket.OPEN;
    try {
      if (socketOpen) session.socket.send(JSON.stringify({ type: 'session.close' }));
      session.socket.close();
    } catch {
      // сокет уже мёртв — cleanup ниже всё равно вычистит состояние
    }
    this.cleanup(session);
    if (!socketOpen) void this.hangup(session.id, this.config.get<string>('OPENAI_API_KEY'));
  }

  private cleanup(session: LiveSession): void {
    if (session.closed) return;
    session.closed = true;
    if (session.maxDurationTimer) clearTimeout(session.maxDurationTimer);
    this.sessions.delete(session.id);
    if (this.sessionByEmployee.get(session.user.id) === session.id) this.sessionByEmployee.delete(session.user.id);
  }

  private onSocketMessage(session: LiveSession, data: WebSocket.RawData): void {
    let event: {
      type?: unknown;
      delta?: unknown;
      start_ms?: unknown;
      end_ms?: unknown;
      offset_ms?: unknown;
      delegation?: { id?: unknown; target?: unknown };
      usage?: unknown;
    };
    try {
      event = JSON.parse(rawDataToString(data)) as typeof event;
    } catch {
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';

    if (type === 'session.input_transcript.delta' || type === 'session.output_transcript.delta') {
      if (typeof event.delta === 'string') {
        const speaker = type === 'session.input_transcript.delta' ? 'user' : 'assistant';
        const startMs = typeof event.start_ms === 'number' ? event.start_ms : undefined;
        const endMs = typeof event.end_ms === 'number' ? event.end_ms : undefined;
        session.transcript.addFragment(speaker, event.delta, startMs, endMs);
        if (speaker === 'user') session.lastUserDeltaAt = Date.now();
      }
      return;
    }
    if (type === 'session.delegation.created') {
      const id = event.delegation?.id;
      if (typeof id !== 'string' || event.delegation?.target !== 'client') return;
      if (session.seenDelegations.has(id)) return;
      session.seenDelegations.add(id);
      this.enqueueDelegation(session, id, typeof event.offset_ms === 'number' ? event.offset_ms : Number.POSITIVE_INFINITY);
      return;
    }
    if (type === 'session.closed') {
      this.logger.log(`live session closed session=${session.id} durationMs=${Date.now() - session.startedAt} usage=${JSON.stringify(event.usage ?? null)}`);
      this.cleanup(session);
      return;
    }
    // Протокол sideband частично не подтверждён документацией — имена
    // (не содержимое!) новых типов событий логируются один раз на сессию,
    // чтобы сверить его по первому живому прогону.
    if (type && !session.unknownEventTypes.has(type)) {
      session.unknownEventTypes.add(type);
      this.logger.log(`live sideband event type=${type}`);
    }
  }

  // Делегации одной сессии обрабатываются строго по порядку (порядок команд в
  // одном разговоре имеет смысл). Ожидание хвоста транскрипта стартует сразу
  // по событию (не когда дойдёт очередь), а очередь ждёт уже готовый снимок.
  private enqueueDelegation(session: LiveSession, delegationId: string, offsetMs: number): void {
    const turn = this.settleAndTakeTurn(session, offsetMs);
    session.queue = session.queue.then(async () => {
      await this.processDelegation(session, delegationId, await turn);
    });
  }

  private async settleAndTakeTurn(
    session: LiveSession,
    offsetMs: number,
  ): Promise<{ command: string; context: string; settle: 'coverage' | 'quiet' | 'cap' }> {
    const startedAt = Date.now();
    let settle: 'coverage' | 'quiet' | 'cap' = 'cap';
    while (Date.now() - startedAt < SETTLE_MAX_MS) {
      if (session.transcript.hasUnconsumedUserText()) {
        if (Number.isFinite(offsetMs) && session.transcript.userCoverageMs >= offsetMs) {
          settle = 'coverage';
          break;
        }
        if (Date.now() - session.lastUserDeltaAt >= SETTLE_QUIET_MS) {
          settle = 'quiet';
          break;
        }
      }
      await new Promise<void>((r) => setTimeout(r, SETTLE_POLL_MS));
    }
    return { ...session.transcript.takeTurn(offsetMs), settle };
  }

  private async processDelegation(
    session: LiveSession,
    delegationId: string,
    turn: { command: string; context: string; settle: string },
  ): Promise<void> {
    const startedAt = Date.now();
    let commentary: string;
    let outcome = 'ok';
    let actions = '-';
    if (!turn.command) {
      commentary = EMPTY_REQUEST_COMMENTARY;
      outcome = 'empty';
    } else {
      try {
        // Делегация выполняется ТЕМ ЖЕ голосовым пайплайном, что и push-to-talk
        // (VoiceService: классификация задача/событие/вопрос → валидация →
        // исполнение), только без STT — транскрипт уже готов. Поэтому Live
        // умеет то же, что голос: создавать/менять/удалять задачи и события,
        // а вопросы уходят в tool loop Assistant Core. clientRequestId привязан
        // к delegation.id — повторная доставка не выполнит действие второй раз
        // (VoiceExecution). Недавний голосовой контекст уходит ТОЛЬКО моделям,
        // в ленту сохраняется чистая команда.
        const response = await this.voice.parseTranscript(session.user, {
          transcript: turn.command.slice(0, MAX_REQUEST_CHARS),
          clientRequestId: `live:${delegationId}`,
          conversationId: session.conversationId,
          liveContext: turn.context || undefined,
        });
        commentary = toSpokenLiveReply(response);
        if (response.results.some((r) => r.type !== 'chat' && !r.ok)) outcome = 'partial';
        actions = response.results.map((r) => (r.type === 'chat' ? 'chat' : `${r.type}:${r.ok ? 'ok' : 'err'}`)).join(',');
      } catch (err) {
        // Текст ошибки не пробрасываем в речь (и не в лог целиком) — тот же
        // принцип, что TOOL_ERROR_MESSAGES: наружу только безопасная фраза.
        this.logger.error(`live delegation failed session=${session.id}: ${err instanceof Error ? err.name : 'unknown'}`);
        commentary = FAILURE_COMMENTARY;
        outcome = 'failed';
      }
    }
    this.logger.log(`live delegation session=${session.id} outcome=${outcome} actions=${actions} settle=${turn.settle} delegationMs=${Date.now() - startedAt}`);
    this.sendCommentary(session, delegationId, commentary);
  }

  private sendCommentary(session: LiveSession, delegationId: string, content: string): void {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) return;
    session.socket.send(
      JSON.stringify({ type: 'session.commentary.append', event_id: `commentary_${randomUUID()}`, delegation_id: delegationId, content }),
    );
  }
}

// ws отдаёт Buffer | ArrayBuffer | Buffer[] — явная склейка вместо неявного
// toString() (у ArrayBuffer/массива он дал бы "[object ...]").
function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

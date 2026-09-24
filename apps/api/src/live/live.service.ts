import { BadGatewayException, Injectable, Logger, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagePartType, MessageStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantChatService, type MessageWithParts } from '../assistant/assistant-chat.service';
import { CreateLiveSessionDto } from './dto/create-live-session.dto';

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
// транскрипта; хвост последних дельт может прийти чуть ПОСЛЕ самого события.
export const DELEGATION_SETTLE_MS = 400;
const MAX_PENDING_INPUT_CHARS = 3000;
const MAX_REQUEST_CHARS = 4000; // SendMessageDto.text
// Лимит append у GPT-Live — 500 токенов; кириллица токенизируется хуже
// латиницы, берём консервативно.
export const MAX_COMMENTARY_CHARS = 900;
const TRUNCATION_SUFFIX = ' Подробности в чате.';
const FAILURE_COMMENTARY = 'Не удалось выполнить запрос, подробности в чате.';
const EMPTY_REQUEST_COMMENTARY = 'Не расслышал запрос, повторите, пожалуйста.';
const EMPTY_ANSWER_COMMENTARY = 'Готово, подробности в чате.';

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
  pendingInput: string;
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

    const response = await fetch(LIVE_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: this.config.get<string>('LIVE_MODEL') || DEFAULT_MODEL,
          instructions: LIVE_INSTRUCTIONS,
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
      pendingInput: '',
      seenDelegations: new Set(),
      queue: Promise.resolve(),
      unknownEventTypes: new Set(),
      maxDurationTimer: null,
      startedAt: Date.now(),
      closed: false,
    };
    this.sessions.set(sessionId, session);
    this.sessionByEmployee.set(user.id, sessionId);

    const maxMs = Number(this.config.get<string>('LIVE_MAX_SESSION_MS')) || DEFAULT_MAX_SESSION_MS;
    session.maxDurationTimer = setTimeout(() => this.closeSession(sessionId, 'max-duration'), maxMs);

    socket.on('message', (data) => this.onSocketMessage(session, data));
    socket.on('close', () => this.cleanup(session));
    socket.on('error', (err) => this.logger.error(`live sideband error session=${sessionId}: ${err instanceof Error ? err.name : 'unknown'}`));

    return { sessionId, sdp: answerSdp };
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
    try {
      if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(JSON.stringify({ type: 'session.close' }));
      }
      session.socket.close();
    } catch {
      // сокет уже мёртв — cleanup ниже всё равно вычистит состояние
    }
    this.cleanup(session);
  }

  private cleanup(session: LiveSession): void {
    if (session.closed) return;
    session.closed = true;
    if (session.maxDurationTimer) clearTimeout(session.maxDurationTimer);
    this.sessions.delete(session.id);
    if (this.sessionByEmployee.get(session.user.id) === session.id) this.sessionByEmployee.delete(session.user.id);
  }

  private onSocketMessage(session: LiveSession, data: WebSocket.RawData): void {
    let event: { type?: unknown; delta?: unknown; delegation?: { id?: unknown; target?: unknown }; usage?: unknown };
    try {
      event = JSON.parse(rawDataToString(data)) as typeof event;
    } catch {
      return;
    }
    const type = typeof event.type === 'string' ? event.type : '';

    if (type === 'session.input_transcript.delta') {
      if (typeof event.delta === 'string') {
        session.pendingInput = (session.pendingInput + event.delta).slice(-MAX_PENDING_INPUT_CHARS);
      }
      return;
    }
    if (type === 'session.delegation.created') {
      const id = event.delegation?.id;
      if (typeof id !== 'string' || event.delegation?.target !== 'client') return;
      if (session.seenDelegations.has(id)) return;
      session.seenDelegations.add(id);
      this.enqueueDelegation(session, id);
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
  // одном разговоре имеет смысл). Текст запроса снимается после короткой
  // «усадки» — хвост транскрипта может прийти после самого события.
  private enqueueDelegation(session: LiveSession, delegationId: string): void {
    const requestText = new Promise<string>((resolve) => {
      setTimeout(() => {
        const text = session.pendingInput.trim();
        session.pendingInput = '';
        resolve(text);
      }, DELEGATION_SETTLE_MS);
    });
    session.queue = session.queue.then(async () => {
      await this.processDelegation(session, delegationId, await requestText);
    });
  }

  private async processDelegation(session: LiveSession, delegationId: string, requestText: string): Promise<void> {
    const startedAt = Date.now();
    let commentary: string;
    let outcome = 'ok';
    if (!requestText) {
      commentary = EMPTY_REQUEST_COMMENTARY;
      outcome = 'empty';
    } else {
      try {
        // clientRequestId привязан к delegation.id — повторная доставка той же
        // делегации не выполнит действие второй раз (тот же exactly-once, что
        // у текстового чата).
        const { assistantMessage } = await this.assistantChat.sendMessage(session.user, session.conversationId, {
          text: requestText.slice(0, MAX_REQUEST_CHARS),
          clientRequestId: `live:${delegationId}`,
        });
        if (assistantMessage.status === MessageStatus.FAILED) {
          commentary = FAILURE_COMMENTARY;
          outcome = 'failed';
        } else {
          commentary = toSpokenCommentary(assistantMessage);
        }
      } catch (err) {
        // Текст ошибки не пробрасываем в речь (и не в лог целиком) — тот же
        // принцип, что TOOL_ERROR_MESSAGES: наружу только безопасная фраза.
        this.logger.error(`live delegation failed session=${session.id}: ${err instanceof Error ? err.name : 'unknown'}`);
        commentary = FAILURE_COMMENTARY;
        outcome = 'failed';
      }
    }
    this.logger.log(`live delegation session=${session.id} outcome=${outcome} delegationMs=${Date.now() - startedAt}`);
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

// Ответ ассистента для озвучивания: только текстовые части, без разметки, с
// жёстким потолком длины (append у GPT-Live ограничен по токенам).
export function toSpokenCommentary(message: MessageWithParts): string {
  const text = message.parts
    .filter((p) => p.type === MessagePartType.MARKDOWN)
    .map((p) => (p.data as { content?: unknown } | null)?.content)
    .filter((c): c is string => typeof c === 'string')
    .join(' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return EMPTY_ANSWER_COMMENTARY;
  if (text.length <= MAX_COMMENTARY_CHARS) return text;
  const budget = MAX_COMMENTARY_CHARS - TRUNCATION_SUFFIX.length;
  const cut = text.slice(0, budget);
  const lastSentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastSentenceEnd > budget / 2 ? cut.slice(0, lastSentenceEnd + 1) : cut.trimEnd()) + TRUNCATION_SUFFIX;
}

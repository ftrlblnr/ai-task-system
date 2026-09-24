import { NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { LiveService, DELEGATION_SETTLE_MS, MAX_COMMENTARY_CHARS, toSpokenCommentary } from './live.service';

// ws мокается целиком — реальный OpenAI/сокет в тестах не участвует.
const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  send = jest.fn();
  close = jest.fn(() => {
    this.readyState = 3;
    this.emit('close');
  });
  constructor(
    public url: string,
    public options: { headers: Record<string, string> },
  ) {
    super();
    sockets.push(this);
  }
}
jest.mock('ws', () => ({ __esModule: true, default: FakeSocketProxy }));
function FakeSocketProxy(this: unknown, url: string, options: { headers: Record<string, string> }) {
  return new FakeSocket(url, options);
}
(FakeSocketProxy as unknown as { OPEN: number }).OPEN = 1;

function user(id = 'emp1') {
  return { id, email: `${id}@x.kz`, role: 'OWNER', isProfileAdmin: true } as any;
}

function assistantMessage(content: string, status = 'COMPLETED') {
  return { status, parts: [{ type: 'MARKDOWN', data: { content } }] };
}

function makeService(env: Record<string, string> = {}) {
  const fullEnv: Record<string, string> = { LIVE_VOICE_ENABLED: 'true', OPENAI_API_KEY: 'sk-test', ...env };
  const config = { get: (k: string) => fullEnv[k] };
  const chat = {
    assertOwnedConversation: jest.fn().mockResolvedValue(undefined),
    getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'conv1' }),
    sendMessage: jest.fn().mockResolvedValue({ assistantMessage: assistantMessage('Готово.') }),
  };
  const service = new LiveService(config as any, chat as any);
  return { service, chat };
}

let fetchMock: jest.Mock;
let sessionCounter = 0;
beforeEach(() => {
  sockets.length = 0;
  sessionCounter = 0;
  jest.useFakeTimers();
  fetchMock = jest.fn().mockImplementation(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ session: { id: `live_${++sessionCounter}` }, transport: { sdp: 'ANSWER_SDP' } }),
  }));
  (global as any).fetch = fetchMock;
});
afterEach(() => {
  jest.useRealTimers();
});

function emit(socket: FakeSocket, event: unknown) {
  socket.emit('message', Buffer.from(JSON.stringify(event)));
}

async function speakAndDelegate(socket: FakeSocket, delegationId: string, text: string) {
  emit(socket, { type: 'session.input_transcript.delta', delta: text });
  emit(socket, { type: 'session.delegation.created', delegation: { id: delegationId, target: 'client' } });
  await jest.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS + 50);
}

function commentaries(socket: FakeSocket) {
  return socket.send.mock.calls.map((c) => JSON.parse(c[0])).filter((e) => e.type === 'session.commentary.append');
}

describe('LiveService.createSession', () => {
  it('шлёт в OpenAI model/delegation client/ограниченные права data channel, подключает sideband с Bearer и возвращает sdp+sessionId', async () => {
    const { service } = makeService();

    const result = await service.createSession(user(), { sdp: 'OFFER_SDP' });

    expect(result).toEqual({ sessionId: 'live_1', sdp: 'ANSWER_SDP' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/live/sessions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.session.model).toBe('gpt-live-1');
    expect(body.session.delegation).toEqual({ type: 'client' });
    expect(body.session.client.data_channel.allowed_client_events).toEqual(['session.close']);
    expect(body.transport).toEqual({ type: 'webrtc', sdp: 'OFFER_SDP' });
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('wss://api.openai.com/v1/live/sessions/live_1/attach');
    expect(sockets[0].options.headers.Authorization).toBe('Bearer sk-test');
  });

  it('фича-флаг выключен — 404, OpenAI не вызывается', async () => {
    const { service } = makeService({ LIVE_VOICE_ENABLED: 'false' });

    await expect(service.createSession(user(), { sdp: 'x' })).rejects.toBeInstanceOf(NotFoundException);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('чужой conversationId — отказ ДО обращения к OpenAI', async () => {
    const { service, chat } = makeService();
    chat.assertOwnedConversation.mockRejectedValue(new NotFoundException());

    await expect(service.createSession(user(), { sdp: 'x', conversationId: 'foreign' })).rejects.toBeInstanceOf(NotFoundException);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it('вторая сессия того же сотрудника закрывает первую (биллинг посекундный)', async () => {
    const { service } = makeService();

    await service.createSession(user(), { sdp: 'a' });
    await service.createSession(user(), { sdp: 'b' });

    expect(sockets[0].close).toHaveBeenCalled();
    expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'session.close' }));
    expect(sockets[1].close).not.toHaveBeenCalled();
  });

  it('сессии разных сотрудников не мешают друг другу', async () => {
    const { service } = makeService();

    await service.createSession(user('a'), { sdp: 'x' });
    await service.createSession(user('b'), { sdp: 'y' });

    expect(sockets[0].close).not.toHaveBeenCalled();
  });

  it('OpenAI ответил ошибкой — BadGateway без утечки деталей, сокет не открывается', async () => {
    const { service } = makeService();
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'secret detail' }) });

    await expect(service.createSession(user(), { sdp: 'x' })).rejects.toThrow('Не удалось запустить живой голос');

    expect(sockets).toHaveLength(0);
  });
});

describe('LiveService — делегации GPT-Live → Assistant Core', () => {
  it('транскрипт + delegation.created → sendMessage с собранным текстом и clientRequestId=live:<id> → commentary.append с delegation_id', async () => {
    const { service, chat } = makeService();
    await service.createSession(user(), { sdp: 'x' });
    const socket = sockets[0];

    emit(socket, { type: 'session.input_transcript.delta', delta: 'Какие у меня ' });
    emit(socket, { type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
    emit(socket, { type: 'session.input_transcript.delta', delta: 'задачи?' }); // хвост после события
    await jest.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS + 50);

    expect(chat.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'emp1' }), 'conv1', {
      text: 'Какие у меня задачи?',
      clientRequestId: 'live:del_1',
    });
    const [c] = commentaries(socket);
    expect(c).toMatchObject({ type: 'session.commentary.append', delegation_id: 'del_1', content: 'Готово.' });
    expect(typeof c.event_id).toBe('string');
  });

  it('повторная доставка того же delegation.id не даёт второго вызова ассистента', async () => {
    const { service, chat } = makeService();
    await service.createSession(user(), { sdp: 'x' });
    const socket = sockets[0];

    emit(socket, { type: 'session.input_transcript.delta', delta: 'Сделай Excel' });
    emit(socket, { type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
    emit(socket, { type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
    await jest.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS + 50);

    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(commentaries(socket)).toHaveLength(1);
  });

  it('делегация не для клиента (target != client) игнорируется', async () => {
    const { service, chat } = makeService();
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'привет');
    emit(sockets[0], { type: 'session.delegation.created', delegation: { id: 'del_2', target: 'responses' } });
    await jest.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS + 50);

    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('ошибка ассистента → безопасная фраза, err.message в речь не попадает', async () => {
    const { service, chat } = makeService();
    chat.sendMessage.mockRejectedValue(new Error('db down: password=secret'));
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'покажи задачи');

    const [c] = commentaries(sockets[0]);
    expect(c.content).toBe('Не удалось выполнить запрос, подробности в чате.');
    expect(JSON.stringify(c)).not.toContain('secret');
  });

  it('ответ ассистента со статусом FAILED → фраза о сбое, не «успех»', async () => {
    const { service, chat } = makeService();
    chat.sendMessage.mockResolvedValue({ assistantMessage: assistantMessage('Частичный текст', 'FAILED') });
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'поставь задачу');

    expect(commentaries(sockets[0])[0].content).toBe('Не удалось выполнить запрос, подробности в чате.');
  });

  it('пустой транскрипт — просьба повторить, ассистент не вызывается', async () => {
    const { service, chat } = makeService();
    await service.createSession(user(), { sdp: 'x' });

    emit(sockets[0], { type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
    await jest.advanceTimersByTimeAsync(DELEGATION_SETTLE_MS + 50);

    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(commentaries(sockets[0])[0].content).toContain('Не расслышал');
  });

  it('две делегации подряд обрабатываются строго по порядку', async () => {
    const { service, chat } = makeService();
    const order: string[] = [];
    let releaseFirst!: () => void;
    chat.sendMessage.mockImplementationOnce(async (_u: unknown, _c: unknown, dto: { text: string }) => {
      order.push('start:' + dto.text);
      await new Promise<void>((r) => (releaseFirst = r));
      order.push('end:' + dto.text);
      return { assistantMessage: assistantMessage('первый') };
    });
    chat.sendMessage.mockImplementationOnce(async (_u: unknown, _c: unknown, dto: { text: string }) => {
      order.push('start:' + dto.text);
      return { assistantMessage: assistantMessage('второй') };
    });
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'один');
    await speakAndDelegate(sockets[0], 'del_2', 'два');
    expect(order).toEqual(['start:один']); // второй ждёт завершения первого

    releaseFirst();
    await jest.advanceTimersByTimeAsync(10);

    expect(order).toEqual(['start:один', 'end:один', 'start:два']);
    expect(commentaries(sockets[0]).map((c) => c.content)).toEqual(['первый', 'второй']);
  });

  it('длинный ответ обрезается до лимита с пометкой про чат', async () => {
    const { service, chat } = makeService();
    chat.sendMessage.mockResolvedValue({ assistantMessage: assistantMessage('Предложение номер один. '.repeat(200)) });
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'расскажи всё');

    const content = commentaries(sockets[0])[0].content as string;
    expect(content.length).toBeLessThanOrEqual(MAX_COMMENTARY_CHARS);
    expect(content.endsWith('Подробности в чате.')).toBe(true);
  });
});

describe('LiveService — жизненный цикл', () => {
  it('session.closed чистит состояние: следующая сессия того же сотрудника не пытается закрыть старую', async () => {
    const { service } = makeService();
    await service.createSession(user(), { sdp: 'a' });
    emit(sockets[0], { type: 'session.closed', usage: { seconds: 5 } });

    await service.createSession(user(), { sdp: 'b' });

    expect(sockets[0].close).not.toHaveBeenCalled();
  });

  it('потолок длительности закрывает сессию', async () => {
    const { service } = makeService({ LIVE_MAX_SESSION_MS: '1000' });
    await service.createSession(user(), { sdp: 'x' });

    await jest.advanceTimersByTimeAsync(1100);

    expect(sockets[0].close).toHaveBeenCalled();
  });

  it('closeForUser: владелец закрывает, чужой — нет', async () => {
    const { service } = makeService();
    await service.createSession(user('owner'), { sdp: 'x' });

    service.closeForUser(user('stranger'), 'live_1');
    expect(sockets[0].close).not.toHaveBeenCalled();

    service.closeForUser(user('owner'), 'live_1');
    expect(sockets[0].close).toHaveBeenCalled();
  });

  it('onModuleDestroy закрывает все sideband', async () => {
    const { service } = makeService();
    await service.createSession(user('a'), { sdp: 'x' });
    await service.createSession(user('b'), { sdp: 'y' });

    service.onModuleDestroy();

    expect(sockets[0].close).toHaveBeenCalled();
    expect(sockets[1].close).toHaveBeenCalled();
  });
});

describe('toSpokenCommentary', () => {
  it('убирает markdown-разметку и склеивает только текстовые части', () => {
    const message = {
      parts: [
        { type: 'MARKDOWN', data: { content: '**Найдено** 3 задачи' } },
        { type: 'TASK_CARD', data: { title: 'не читать' } },
      ],
    } as any;

    expect(toSpokenCommentary(message)).toBe('Найдено 3 задачи');
  });

  it('нет текста — нейтральная фраза', () => {
    expect(toSpokenCommentary({ parts: [] } as any)).toBe('Готово, подробности в чате.');
  });
});

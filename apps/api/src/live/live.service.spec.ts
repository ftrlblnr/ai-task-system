import { NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { LiveService, SETTLE_MAX_MS, SETTLE_QUIET_MS, SIDEBAND_OPEN_TIMEOUT_MS } from './live.service';
import { MAX_COMMENTARY_CHARS } from './live-spoken-reply';

// ws мокается целиком — реальный OpenAI/сокет в тестах не участвует.
const sockets: FakeSocket[] = [];
class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static startOpen = true;
  readyState = FakeSocket.startOpen ? 1 : 0;
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

// Ответ VoiceService.parseTranscript: выполненные results[] (см. VoiceParseResponse).
function chatResponse(reply: string) {
  return { results: [{ type: 'chat', reply }], clarificationReason: null };
}

function makeService(env: Record<string, string> = {}) {
  const fullEnv: Record<string, string> = { LIVE_VOICE_ENABLED: 'true', OPENAI_API_KEY: 'sk-test', ...env };
  const config = { get: (k: string) => fullEnv[k] };
  const chat = {
    assertOwnedConversation: jest.fn().mockResolvedValue(undefined),
    getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'conv1' }),
    getRecentMessages: jest.fn().mockResolvedValue([]),
  };
  const voice = { parseTranscript: jest.fn().mockResolvedValue(chatResponse('Готово.')) };
  const service = new LiveService(config as any, chat as any, voice as any);
  return { service, chat, voice };
}

let fetchMock: jest.Mock;
let sessionCounter = 0;
beforeEach(() => {
  FakeSocket.startOpen = true;
  sockets.length = 0;
  sessionCounter = 0;
  jest.useFakeTimers();
  fetchMock = jest.fn().mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ session: { id: `live_${++sessionCounter}` }, transport: { sdp: 'ANSWER_SDP' } }),
    }),
  );
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
  await jest.advanceTimersByTimeAsync(SETTLE_MAX_MS + 50);
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
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: 'secret detail' }) });

    await expect(service.createSession(user(), { sdp: 'x' })).rejects.toThrow('Не удалось запустить живой голос');

    expect(sockets).toHaveLength(0);
  });
});

describe('LiveService — делегации GPT-Live → Assistant Core', () => {
  it('транскрипт + delegation.created → voice.parseTranscript с собранным текстом и clientRequestId=live:<id> → commentary.append с delegation_id', async () => {
    const { service, voice } = makeService();
    await service.createSession(user(), { sdp: 'x' });
    const socket = sockets[0];

    emit(socket, { type: 'session.input_transcript.delta', delta: 'Какие у меня ' });
    emit(socket, { type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
    emit(socket, { type: 'session.input_transcript.delta', delta: 'задачи?' }); // хвост после события
    await jest.advanceTimersByTimeAsync(SETTLE_MAX_MS + 50);

    expect(voice.parseTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'emp1' }),
      expect.objectContaining({ transcript: 'Какие у меня задачи?', clientRequestId: 'live:del_1', conversationId: 'conv1' }),
    );
    const [c] = commentaries(socket);
    expect(c).toMatchObject({ type: 'session.commentary.append', delegation_id: 'del_1', content: 'Готово.' });
    expect(typeof c.event_id).toBe('string');
  });

  it('повторная доставка того же delegation.id не даёт второго вызова ассистента', async () => {
    const { service, voice } = makeService();
    await service.createSession(user(), { sdp: 'x' });
    const socket = sockets[0];

    emit(socket, { type: 'session.input_transcript.delta', delta: 'Сделай Excel' });
    emit(socket, { type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
    emit(socket, { type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
    await jest.advanceTimersByTimeAsync(SETTLE_MAX_MS + 50);

    expect(voice.parseTranscript).toHaveBeenCalledTimes(1);
    expect(commentaries(socket)).toHaveLength(1);
  });

  it('делегация не для клиента (target != client) игнорируется', async () => {
    const { service, voice } = makeService();
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'привет');
    emit(sockets[0], { type: 'session.delegation.created', delegation: { id: 'del_2', target: 'responses' } });
    await jest.advanceTimersByTimeAsync(SETTLE_MAX_MS + 50);

    expect(voice.parseTranscript).toHaveBeenCalledTimes(1);
  });

  it('ошибка ассистента → безопасная фраза, err.message в речь не попадает', async () => {
    const { service, voice } = makeService();
    voice.parseTranscript.mockRejectedValue(new Error('db down: password=secret'));
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'покажи задачи');

    const [c] = commentaries(sockets[0]);
    expect(c.content).toBe('Не удалось выполнить запрос, подробности в чате.');
    expect(JSON.stringify(c)).not.toContain('secret');
  });

  it('действие не выполнилось (ok=false) → честная фраза о сбое, не «успех», без текста ошибки', async () => {
    const { service, voice } = makeService();
    voice.parseTranscript.mockResolvedValue({
      results: [{ type: 'task_action', ok: false, error: 'db down: password=secret', draft: { action: 'create', title: 'Купить мясо' } }],
      clarificationReason: null,
    });
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'поставь задачу');

    expect(commentaries(sockets[0])[0].content).toBe('Не удалось создать задачу «Купить мясо», подробности в чате.');
    expect(JSON.stringify(commentaries(sockets[0]))).not.toContain('secret');
  });

  it('пустой транскрипт — просьба повторить, ассистент не вызывается', async () => {
    const { service, voice } = makeService();
    await service.createSession(user(), { sdp: 'x' });

    emit(sockets[0], { type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
    await jest.advanceTimersByTimeAsync(SETTLE_MAX_MS + 50);

    expect(voice.parseTranscript).not.toHaveBeenCalled();
    expect(commentaries(sockets[0])[0].content).toContain('Не расслышал');
  });

  it('две делегации подряд обрабатываются строго по порядку', async () => {
    const { service, voice } = makeService();
    const order: string[] = [];
    let releaseFirst!: () => void;
    voice.parseTranscript.mockImplementationOnce(async (_u: unknown, params: { transcript: string }) => {
      order.push('start:' + params.transcript);
      await new Promise<void>((r) => (releaseFirst = r));
      order.push('end:' + params.transcript);
      return chatResponse('первый');
    });
    voice.parseTranscript.mockImplementationOnce((_u: unknown, params: { transcript: string }) => {
      order.push('start:' + params.transcript);
      return Promise.resolve(chatResponse('второй'));
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
    const { service, voice } = makeService();
    voice.parseTranscript.mockResolvedValue(chatResponse('Предложение номер один. '.repeat(200)));
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

// ---- Stage 2, Phase Q hardening (24.09.2026) ----

describe('LiveService — контекст живого разговора уходит в Assistant Core', () => {
  it('«создай из этого…»: parseTranscript получает ЧИСТУЮ команду и liveContext с прошлым ходом пользователя и прошлой репликой Live', async () => {
    const { service, voice } = makeService();
    await service.createSession(user(), { sdp: 'x' });
    const socket = sockets[0];

    emit(socket, { type: 'session.input_transcript.delta', delta: 'Мы обсуждали предложение IDAT. ', start_ms: 0, end_ms: 2000 });
    emit(socket, { type: 'session.output_transcript.delta', delta: 'Да, речь шла о стоимости автоматизации. ', start_ms: 2100, end_ms: 4000 });
    emit(socket, { type: 'session.delegation.created', offset_ms: 2000, delegation: { id: 'del_1', target: 'client' } });
    await jest.advanceTimersByTimeAsync(SETTLE_MAX_MS + 50);
    emit(socket, { type: 'session.input_transcript.delta', delta: 'Создай из этого задачу Жандосу.', start_ms: 4500, end_ms: 6500 });
    emit(socket, { type: 'session.delegation.created', offset_ms: 6600, delegation: { id: 'del_2', target: 'client' } });
    await jest.advanceTimersByTimeAsync(SETTLE_MAX_MS + 50);

    const [, params] = voice.parseTranscript.mock.calls[1];
    expect(params).toMatchObject({ transcript: 'Создай из этого задачу Жандосу.', clientRequestId: 'live:del_2' });
    expect(params.liveContext).toContain('User: Мы обсуждали предложение IDAT.');
    expect(params.liveContext).toContain('Assistant: Да, речь шла о стоимости автоматизации.');
    expect(params.liveContext).not.toContain('Создай из этого');
  });

  it('не зависит от фиксированной паузы: хвост речи, пришедший через 600 мс после события (дельты идут непрерывно), входит в команду', async () => {
    const { service, voice } = makeService();
    await service.createSession(user(), { sdp: 'x' });
    const socket = sockets[0];

    emit(socket, { type: 'session.input_transcript.delta', delta: 'Поставь ' });
    emit(socket, { type: 'session.delegation.created', delegation: { id: 'del_1', target: 'client' } });
    for (const part of ['Жандосу ', 'задачу ', 'до ']) {
      await jest.advanceTimersByTimeAsync(200);
      emit(socket, { type: 'session.input_transcript.delta', delta: part });
    }
    await jest.advanceTimersByTimeAsync(200);
    emit(socket, { type: 'session.input_transcript.delta', delta: 'пятницы' });
    await jest.advanceTimersByTimeAsync(SETTLE_MAX_MS + 50);

    expect(voice.parseTranscript.mock.calls[0][1].transcript).toBe('Поставь Жандосу задачу до пятницы');
  });

  it('покрытие user-речи дошло до offset_ms — ответ не ждёт тишины', async () => {
    const { service, voice } = makeService();
    await service.createSession(user(), { sdp: 'x' });
    const socket = sockets[0];

    emit(socket, { type: 'session.input_transcript.delta', delta: 'Покажи задачи', start_ms: 0, end_ms: 1000 });
    emit(socket, { type: 'session.delegation.created', offset_ms: 900, delegation: { id: 'del_1', target: 'client' } });
    await jest.advanceTimersByTimeAsync(SETTLE_QUIET_MS - 100);

    expect(voice.parseTranscript).toHaveBeenCalledTimes(1);
  });

  it('пустой контекст (первая реплика) — liveContext не передаётся', async () => {
    const { service, voice } = makeService();
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'Привет');

    expect(voice.parseTranscript.mock.calls[0][1].liveContext).toBeUndefined();
  });
});

describe('LiveService — session.input из истории разговора', () => {
  function postedSession() {
    return JSON.parse(fetchMock.mock.calls[0][1].body).session;
  }

  it('последние сообщения чата передаются в session.input', async () => {
    const { service, chat } = makeService();
    chat.getRecentMessages.mockResolvedValue([
      { role: 'user', text: 'Мы обсуждали вчера IDAT.' },
      { role: 'assistant', text: 'Да, помню.' },
    ]);

    await service.createSession(user(), { sdp: 'x' });

    expect(chat.getRecentMessages).toHaveBeenCalledWith(expect.objectContaining({ id: 'emp1' }), 'conv1', 20);
    expect(postedSession().input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Мы обсуждали вчера IDAT.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Да, помню.' }] },
    ]);
  });

  it('пустой разговор — поле input не передаётся, сессия создаётся', async () => {
    const { service } = makeService();

    await service.createSession(user(), { sdp: 'x' });

    expect('input' in postedSession()).toBe(false);
  });

  it('сбой чтения истории не блокирует живой голос', async () => {
    const { service, chat } = makeService();
    chat.getRecentMessages.mockRejectedValue(new Error('db down'));

    await expect(service.createSession(user(), { sdp: 'x' })).resolves.toMatchObject({ sessionId: 'live_1' });
    expect('input' in postedSession()).toBe(false);
  });
});

describe('LiveService — sideband готов до ответа клиенту', () => {
  it('createSession не резолвится, пока sideband не открылся', async () => {
    FakeSocket.startOpen = false;
    const { service } = makeService();
    let resolved = false;

    const promise = service.createSession(user(), { sdp: 'x' }).then((r) => {
      resolved = true;
      return r;
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);

    sockets[0].readyState = 1;
    sockets[0].emit('open');
    await expect(promise).resolves.toEqual({ sessionId: 'live_1', sdp: 'ANSWER_SDP' });
  });

  it('sideband не открылся за таймаут — hangup через REST, состояние очищено, контролируемая ошибка', async () => {
    FakeSocket.startOpen = false;
    const { service } = makeService();

    const promise = service.createSession(user(), { sdp: 'x' });
    const assertion = expect(promise).rejects.toThrow('Не удалось запустить живой голос');
    await jest.advanceTimersByTimeAsync(SIDEBAND_OPEN_TIMEOUT_MS + 100);
    await assertion;

    const hangupCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/live_1/hangup'));
    expect(hangupCall).toBeDefined();
    expect(hangupCall![1].headers.Authorization).toBe('Bearer sk-test');
    expect(sockets[0].close).toHaveBeenCalled();
    // состояние очищено: следующая сессия не пытается закрывать «призрак»
    FakeSocket.startOpen = true;
    await service.createSession(user(), { sdp: 'y' });
    expect(sockets[1].close).not.toHaveBeenCalled();
  });

  it('ошибка сокета до open — тот же cleanup и hangup', async () => {
    FakeSocket.startOpen = false;
    const { service } = makeService();

    const promise = service.createSession(user(), { sdp: 'x' });
    const assertion = expect(promise).rejects.toThrow('Не удалось запустить живой голос');
    await jest.advanceTimersByTimeAsync(10);
    sockets[0].emit('error', new Error('ECONNREFUSED'));
    await assertion;

    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/live_1/hangup'))).toBe(true);
  });

  it('успешный путь: sideband уже открыт — ответ без ожидания', async () => {
    const { service } = makeService();

    const result = await service.createSession(user(), { sdp: 'x' });

    expect(result.sessionId).toBe('live_1');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/hangup'))).toBe(false);
  });

  it('закрытие сессии с мёртвым sideband использует hangup', async () => {
    const { service } = makeService();
    await service.createSession(user(), { sdp: 'x' });
    sockets[0].readyState = 3; // сокет уже мёртв, но карта ещё помнит сессию

    service.closeForUser(user(), 'live_1');
    await jest.advanceTimersByTimeAsync(10);

    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/live_1/hangup'))).toBe(true);
  });
});

// Регресс живого режима (24.09.2026): «Поставь задачу Азамату…» и «сделай запись в
// календаре…» уходили в текстовый Assistant Core без tools создания задач/событий.
describe('LiveService — делегации исполняются голосовым пайплайном (создание задач и событий)', () => {
  it('«поставь задачу … и сделай запись в календаре»: одна делегация → parseTranscript, ответ озвучивает ОБА созданных объекта', async () => {
    const { service, voice } = makeService();
    voice.parseTranscript.mockResolvedValue({
      results: [
        { type: 'task_action', ok: true, error: null, taskId: 't1', undoToken: null, draft: { action: 'create', title: 'Купить мясо', assigneeName: 'Азамат', dueDate: '2026-09-25T18:00:00' } },
        { type: 'event_action', ok: true, error: null, eventId: 'e1', undoToken: null, warning: null, draft: { action: 'create', title: 'Встреча с IDAT', startAt: '2026-09-25T15:00:00', allDay: false } },
      ],
      clarificationReason: null,
    });
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'Поставь задачу на завтра на Азамата купить мясо, и сделай запись в календаре на завтра в 15:00 встреча с IDAT');

    expect(voice.parseTranscript).toHaveBeenCalledTimes(1);
    const content = commentaries(sockets[0])[0].content as string;
    expect(content).toContain('Создал задачу «Купить мясо»');
    expect(content).toContain('Добавил в календарь «Встреча с IDAT» на 25 сентября в 15:00');
  });

  it('один из результатов не выполнен — озвучивается сбой, а не «успех»', async () => {
    const { service, voice } = makeService();
    voice.parseTranscript.mockResolvedValue({
      results: [{ type: 'event_action', ok: false, error: 'boom', warning: null, draft: { action: 'create', title: 'Встреча' } }],
      clarificationReason: null,
    });
    await service.createSession(user(), { sdp: 'x' });

    await speakAndDelegate(sockets[0], 'del_1', 'Добавь встречу');

    expect(commentaries(sockets[0])[0].content).toBe('Не удалось добавить встречу «Встреча», подробности в чате.');
  });
});

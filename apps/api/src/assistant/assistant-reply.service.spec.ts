import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantReplyService, buildDateContext, stripLeakedContextMarkers } from './assistant-reply.service';

// Stage 2, Phase L (внешний аудит 21.09.2026, находка №5) — раньше tool
// loop был жёстко ограничен ОДНИМ раундом (второй запрос инструмента от
// модели молча игнорировался, брался текст как есть, даже пустой). Тесты
// здесь мокируют приватный streamOnce (реальный вызов Anthropic SDK не
// трогаем — messages.stream() тестировать нечем без живого ключа/сети,
// тот же принцип, что уже применяется к DraftExtractionService/
// WhisperService в этом проекте) и проверяют именно ЦИКЛ раундов — сколько
// раз streamOnce/tools.execute реально вызываются и когда цикл
// останавливается.

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.OWNER, ...overrides };
}

function textMessage(text: string): any {
  return { content: [{ type: 'text', text }] };
}

function toolUseMessage(name: string, id: string, input: unknown = {}): any {
  return { content: [{ type: 'tool_use', id, name, input }] };
}

function makeService(streamResponses: any[], toolResults: unknown[] = []) {
  const tools = {
    buildTools: jest.fn().mockReturnValue([]),
    execute: jest.fn().mockImplementation(() => Promise.resolve(toolResults.shift() ?? { tool: 'get_tasks', items: [], totalCount: 0 })),
  };
  const service = new AssistantReplyService({ get: () => undefined } as any, tools as any) as any;
  const streamOnce = jest.spyOn(service, 'streamOnce');
  for (const response of streamResponses) {
    streamOnce.mockImplementationOnce(() => Promise.resolve(response));
  }
  return { service, tools, streamOnce };
}

describe('AssistantReplyService.reply — ограниченный многораундовый tool use (Stage 2, Phase L)', () => {
  it('без tool_use — один раунд, инструменты не вызываются', async () => {
    const { service, tools, streamOnce } = makeService([textMessage('Привет!')]);

    const result = await service.reply('Привет', [], user(), 'c1', 'm1');

    expect(streamOnce).toHaveBeenCalledTimes(1);
    expect(tools.execute).not.toHaveBeenCalled();
    expect(result).toEqual({ text: 'Привет!', toolCalls: [] });
  });

  it('два последовательных раунда tool use (get_recent_meetings → search_meeting_transcript) — оба выполняются, третий раунд даёт финальный текст', async () => {
    const { service, tools, streamOnce } = makeService(
      [
        toolUseMessage('get_recent_meetings', 'call-1'),
        toolUseMessage('search_meeting_transcript', 'call-2'),
        textMessage('Нашёл: он сказал про сроки в четверг.'),
      ],
      [
        { tool: 'get_recent_meetings', items: [{ id: 'm1' }], totalCount: 1 },
        { tool: 'search_meeting_transcript', items: [{ meetingId: 'm1' }], totalCount: 1 },
      ],
    );

    const result = await service.reply('Найди встречу с Петром и процитируй про сроки', [], user(), 'c1', 'm1');

    expect(streamOnce).toHaveBeenCalledTimes(3);
    expect(tools.execute).toHaveBeenCalledTimes(2);
    expect(tools.execute.mock.calls[0][0]).toBe('get_recent_meetings');
    expect(tools.execute.mock.calls[1][0]).toBe('search_meeting_transcript');
    expect(result.text).toBe('Нашёл: он сказал про сроки в четверг.');
    expect(result.toolCalls.map((c) => c.name)).toEqual(['get_recent_meetings', 'search_meeting_transcript']);
  });

  // РЕГРЕССИЯ находки №5 — до этого фикса ВТОРОЙ раунд tool_use вообще не
  // выполнялся (только залогировать warn и вернуть текст как есть), что
  // здесь эквивалентно streamOnce, вызванному лишь дважды и tools.execute
  // лишь один раз. MAX_TOOL_ROUNDS=5 (единый агент A2, было 3) разрешает до
  // 5 раундов выполнения инструментов (6 вызовов streamOnce: 5 раундов
  // tool_use + 1 финальный).
  it('MAX_TOOL_ROUNDS=5 — модель просит инструмент шестой раз подряд, цикл останавливается, texт берётся как есть', async () => {
    const empty = { tool: 'get_recent_meetings', items: [], totalCount: 0 };
    const { service, tools, streamOnce } = makeService(
      [
        toolUseMessage('get_recent_meetings', 'call-1'),
        toolUseMessage('get_recent_meetings', 'call-2'),
        toolUseMessage('get_recent_meetings', 'call-3'),
        toolUseMessage('get_recent_meetings', 'call-4'),
        toolUseMessage('get_recent_meetings', 'call-5'),
        toolUseMessage('get_recent_meetings', 'call-6'), // сверх лимита — не выполняется
      ],
      [empty, empty, empty, empty, empty],
    );

    const result = await service.reply('Зациклись', [], user(), 'c1', 'm1');

    // 6 вызовов streamOnce (раунды 1-6), но tools.execute — только 5 раз
    // (раунды 1-5); 6-й ответ модели с tool_use не выполняется, цикл
    // останавливается и берёт его (пустой) текст как есть.
    expect(streamOnce).toHaveBeenCalledTimes(6);
    expect(tools.execute).toHaveBeenCalledTimes(5);
    expect(result.toolCalls).toHaveLength(5);
  });

  // Раздел 15 спеки Phase O ("Meeting → Task workflow") — write-tool
  // (create_task_from_meeting) должен уметь быть ЛЮБЫМ раундом, включая
  // третий по счёту — runReply не делает разницы между read- и
  // write-инструментами, дальнейшая идемпотентность/валидация — целиком
  // внутри самого AssistantToolsService.execute (см. её тесты).
  it('write-tool create_task_from_meeting корректно выполняется на 3-м раунде, получает conversationId/userMessageId', async () => {
    const { service, tools, streamOnce } = makeService(
      [
        toolUseMessage('search_meetings', 'call-1'),
        toolUseMessage('search_meeting_transcript', 'call-2'),
        toolUseMessage('create_task_from_meeting', 'call-3', { meetingId: 'm1', title: 'Получить КП' }),
        textMessage('Готово, задача создана.'),
      ],
      [
        { tool: 'search_meetings', items: [{ meetingId: 'm1' }], totalCount: 1 },
        { tool: 'search_meeting_transcript', items: [{ meetingId: 'm1' }], totalCount: 1 },
        { tool: 'create_task_from_meeting', task: { taskId: 't1', title: 'Получить КП', status: 'NEW', dueDate: null, assignee: null } },
      ],
    );

    const result = await service.reply('Найди встречу и поставь задачу', [], user(), 'conv1', 'userMsg1');

    expect(streamOnce).toHaveBeenCalledTimes(4);
    expect(tools.execute).toHaveBeenCalledTimes(3);
    expect(tools.execute.mock.calls[2][0]).toBe('create_task_from_meeting');
    // conversationId/userMessageId прокидываются на КАЖДЫЙ раунд одинаково
    // (см. комментарий runReply про Phase O) — не только для write-tool'а.
    for (const call of tools.execute.mock.calls) {
      expect(call[3]).toBe('conv1');
      expect(call[4]).toBe('userMsg1');
    }
    expect(result.toolCalls.map((c) => c.name)).toEqual(['search_meetings', 'search_meeting_transcript', 'create_task_from_meeting']);
    expect(result.text).toBe('Готово, задача создана.');
  });

  // Hardening-раунд (22.09.2026, P0/P1 "stable tool idempotency"),
  // уточнено roadmap v13 MUST-FIX #2 (23.09.2026) — writeToolCallIndex
  // должен монотонно расти по ВСЕМ раундам одного вызова reply(), не
  // сбрасываться между раундами, не зависеть от того, сколько tool_use
  // было в предыдущем раунде, И НЕ ДВИГАТЬСЯ на read-tool'ах (регрессия
  // самого MUST-FIX #2 — раньше search_meetings тоже получал числовой
  // индекс, из-за чего порядок read/write вызовов влиял на dedupeKey).
  it('writeToolCallIndex монотонно растёт только на write-tool\'ах, read-tool получает undefined', async () => {
    const twoToolsInOneRound = {
      content: [
        { type: 'tool_use', id: 'call-1', name: 'search_meetings', input: {} },
        { type: 'tool_use', id: 'call-2', name: 'create_task_from_meeting', input: { meetingId: 'm1', title: 'A' } },
      ],
    };
    const { service, tools } = makeService(
      [
        twoToolsInOneRound as any,
        toolUseMessage('create_task_from_meeting', 'call-3', { meetingId: 'm1', title: 'B' }),
        textMessage('Готово.'),
      ],
      [
        { tool: 'search_meetings', items: [], totalCount: 0 },
        { tool: 'create_task_from_meeting', task: { taskId: 't1', title: 'A', status: 'NEW', dueDate: null, assignee: null } },
        { tool: 'create_task_from_meeting', task: { taskId: 't2', title: 'B', status: 'NEW', dueDate: null, assignee: null } },
      ],
    );

    await service.reply('Создай две задачи', [], user(), 'conv1', 'userMsg1');

    expect(tools.execute).toHaveBeenCalledTimes(3);
    // Раунд 1: read-tool (search_meetings) получает undefined (счётчик не
    // трогается), следующий за ним write-tool получает 0. Раунд 2:
    // следующий write-tool получает 1 (продолжает счёт среди write-tool'ов,
    // не начинает заново с 0 на новом раунде, и не "видит" read-tool из
    // раунда 1 как сдвиг индекса).
    expect(tools.execute.mock.calls.map((c) => c[5])).toEqual([undefined, 0, 1]);
  });

  it('инструмент возвращает error — is_error попадает в tool_result, следующий раунд всё равно выполняется', async () => {
    const { service, tools } = makeService(
      [toolUseMessage('get_tasks', 'call-1'), textMessage('Не получилось получить задачи.')],
      [{ tool: 'get_tasks', error: true, message: 'db down' }],
    );

    const result = await service.reply('Покажи задачи', [], user(), 'c1', 'm1');

    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(result.toolCalls[0].result).toEqual({ tool: 'get_tasks', error: true, message: 'db down' });
    expect(result.text).toBe('Не получилось получить задачи.');
  });
});

// Stage 2, Phase O (Meeting → Task workflow, 22.09.2026) — раньше
// SYSTEM_PROMPT вообще не содержал текущей даты/времени (в отличие от
// voice, draft-extraction.service.ts), из-за чего create_task_from_meeting
// не мог бы разрешать "до пятницы"/"завтра" в dueDate. buildDateContext —
// тот же nowInLocalTimezone()-паттерн, что уже используется в voice.
describe('buildDateContext (Stage 2, Phase O)', () => {
  it('содержит текущую дату/время по местному времени и явно называет поле dueDate инструмента create_task_from_meeting', () => {
    const context = buildDateContext();

    expect(context).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(context).toContain('create_task_from_meeting');
    expect(context).not.toMatch(/Z$/m);
  });
});

// streamOnce — единственное место, где system-строка реально собирается и
// уходит в Anthropic SDK; остальные тесты в этом файле мокируют streamOnce
// целиком (см. комментарий makeService), поэтому не могут поймать регресс
// здесь — эта проверка вызывает НАСТОЯЩИЙ streamOnce с подменённым
// client'ом (минуя ленивую getClient(), которой в тестах не нужен реальный
// ANTHROPIC_API_KEY).
describe('AssistantReplyService.streamOnce — system-промпт и кэш (21.10.2026)', () => {
  function makeStreamingService() {
    const service = new AssistantReplyService({ get: () => undefined } as any, { buildTools: jest.fn().mockResolvedValue([]) } as any) as any;
    const streamSpy = jest
      .fn()
      .mockReturnValue({ on: jest.fn(), finalMessage: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }], usage: {} }) });
    service.client = { messages: { stream: streamSpy } };
    return { service, streamSpy };
  }

  it('system — неизменный SYSTEM_PROMPT с меткой кэша на 1 час, без текущей даты', async () => {
    const { service, streamSpy } = makeStreamingService();

    await service.reply('привет', [], { id: 'u1', role: 'OWNER' }, 'c1', 'm1');

    const [payload] = streamSpy.mock.calls[0];
    expect(payload.system).toHaveLength(1);
    expect(payload.system[0].text).toContain('ассистент корпоративной системы задач');
    expect(payload.system[0].text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(payload.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(payload.cache_control).toEqual({ type: 'ephemeral' });
  });

  // ARMS, фаза 1: индекс памяти — вторым блоком system (тоже в кэше), только
  // руководству; сводка ранней части разговора — перед историей.
  it('индекс памяти — второй блок system у руководителя, у сотрудника его нет', async () => {
    const memory = { buildIndex: jest.fn().mockResolvedValue('[memory]\n- [PREFERENCE] xlsx (m1)\n[/memory]') };
    const make = () => {
      const service = new AssistantReplyService({ get: () => undefined } as any, { buildTools: jest.fn().mockResolvedValue([]) } as any, undefined, memory as any) as any;
      const streamSpy = jest.fn().mockReturnValue({ on: jest.fn(), finalMessage: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }], usage: {} }) });
      service.client = { messages: { stream: streamSpy } };
      return { service, streamSpy };
    };
    const owner = make();
    await owner.service.reply('привет', [], { id: 'u1', role: 'OWNER' }, 'c1', 'm1', '- решили перенести сдачу');
    const [payload] = owner.streamSpy.mock.calls[0];
    expect(payload.system).toHaveLength(2);
    expect(payload.system[1].text).toContain('[memory]');
    expect(payload.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(payload.messages[0]).toEqual({ role: 'user', content: '[conversation_summary]\n- решили перенести сдачу\n[/conversation_summary]' });

    const employee = make();
    await employee.service.reply('привет', [], { id: 'u2', role: 'EMPLOYEE' }, 'c1', 'm1');
    expect(employee.streamSpy.mock.calls[0][0].system).toHaveLength(1);
    expect(memory.buildIndex).toHaveBeenCalledTimes(1);
  });

  it('текущая дата уходит в последнее сообщение пользователя', async () => {
    const { service, streamSpy } = makeStreamingService();

    await service.reply('что завтра?', [], { id: 'u1', role: 'OWNER' }, 'c1', 'm1');

    const [payload] = streamSpy.mock.calls[0];
    const last = payload.messages[payload.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content[0].text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(last.content[1].text).toBe('что завтра?');
  });
});

describe('stripLeakedContextMarkers — блок [live_context] (Stage 2, Phase Q hardening)', () => {
  it('вырезает утёкший блок [live_context]…[/live_context] из ответа модели', () => {
    const leaked = 'Готово.\n[live_context]\nUser: Мы обсуждали IDAT.\nAssistant: Да.\n[/live_context]\nЗадача создана.';

    expect(stripLeakedContextMarkers(leaked)).not.toContain('live_context');
    expect(stripLeakedContextMarkers(leaked)).not.toContain('Мы обсуждали');
    expect(stripLeakedContextMarkers(leaked)).toContain('Задача создана.');
  });

  it('обычный текст с квадратными скобками не трогает', () => {
    expect(stripLeakedContextMarkers('Смотри [1] и [2].')).toBe('Смотри [1] и [2].');
  });
});

describe('AssistantReplyService — несколько инструментов в одном раунде (21.10.2026)', () => {
  function twoTools(first: string, second: string): any {
    return {
      content: [
        { type: 'tool_use', id: 'call-1', name: first, input: {} },
        { type: 'tool_use', id: 'call-2', name: second, input: {} },
      ],
    };
  }

  it('только чтение — инструменты стартуют одновременно, результаты в порядке блоков', async () => {
    const { service, tools } = makeService([twoTools('get_tasks', 'get_events'), textMessage('Готово')]);
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    tools.execute.mockImplementation(async (name: string) => {
      started.push(name);
      if (started.length === 2) release();
      await gate;
      return { tool: name };
    });

    const result = await service.reply('задачи и календарь', [], user(), 'c1', 'm1');

    expect(started).toEqual(['get_tasks', 'get_events']);
    expect(result.toolCalls.map((c: { name: string }) => c.name)).toEqual(['get_tasks', 'get_events']);
  });

  it('есть запись — по очереди, индексы write-вызовов по порядку блоков', async () => {
    const { service, tools } = makeService([twoTools('create_task_from_meeting', 'create_task_from_meeting'), textMessage('Готово')]);
    let running = 0;
    let maxRunning = 0;
    tools.execute.mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Promise.resolve();
      running--;
      return { tool: 'create_task_from_meeting' };
    });

    await service.reply('две задачи', [], user(), 'c1', 'm1');

    expect(maxRunning).toBe(1);
    expect(tools.execute.mock.calls.map((c: unknown[]) => c[5])).toEqual([0, 1]);
  });
});

// ARMS, фаза 3 — навык: своя модель/effort, только разрешённые инструменты,
// блок [skill] последним (без своей метки кэша), журнал skill.run:<slug>.
describe('AssistantReplyService — навыки и роутер (ARMS 3)', () => {
  const skill = {
    id: 's1',
    slug: 'к-встрече',
    title: 'Подготовка к встрече',
    instructions: 'Найди встречу и участников.',
    model: 'OPUS' as const,
    effort: 'MEDIUM' as const,
    allowedTools: ['get_events'],
    output: 'CHAT' as const,
  };
  const tool = (name: string) => ({ name, description: name, input_schema: { type: 'object', properties: {} } });

  function make(opts: { config?: Record<string, string>; skills?: unknown; create?: jest.Mock } = {}) {
    const aiUsage = { record: jest.fn(), track: jest.fn((_f: string, _m: string, call: () => Promise<unknown>) => call()) };
    const service = new AssistantReplyService(
      { get: (k: string) => opts.config?.[k] } as any,
      { buildTools: jest.fn().mockResolvedValue([tool('get_tasks'), tool('get_events')]) } as any,
      aiUsage as any,
      undefined,
      opts.skills as any,
    ) as any;
    const streamSpy = jest.fn().mockReturnValue({ on: jest.fn(), finalMessage: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }], usage: {} }) });
    service.client = { messages: { stream: streamSpy, create: opts.create } };
    return { service, streamSpy, aiUsage };
  }

  it('навык: модель Opus, effort medium, только разрешённые инструменты, блок навыка третьим без метки кэша', async () => {
    const skills = { toneBlock: jest.fn().mockResolvedValue('[tone]\nкоротко\n[/tone]') };
    const { service, streamSpy, aiUsage } = make({ skills });
    await service.reply('к встрече с Ахметовым', [], { id: 'u1', role: 'OWNER' }, 'c1', 'm1', null, skill);
    const [payload] = streamSpy.mock.calls[0];
    expect(payload.model).toBe('claude-opus-5-5');
    expect(payload.output_config).toEqual({ effort: 'medium' });
    expect(payload.max_tokens).toBe(16000);
    expect(payload.tools.map((t: { name: string }) => t.name)).toEqual(['get_events']);
    expect(payload.system).toHaveLength(3);
    expect(payload.system[1].text).toContain('[tone]');
    expect(payload.system[2].text).toContain('[skill /к-встрече — Подготовка к встрече]');
    expect(payload.system[2].cache_control).toBeUndefined();
    expect(aiUsage.record).toHaveBeenCalledWith(expect.objectContaining({ feature: 'skill.run:к-встрече', model: 'claude-opus-5-5', meta: { skillId: 's1' } }));
  });

  it('навык без инструментов — запрос без tools и tool_choice', async () => {
    const { service, streamSpy } = make();
    await service.reply('x', [], { id: 'u1', role: 'OWNER' }, 'c1', 'm1', null, { ...skill, allowedTools: [] });
    const [payload] = streamSpy.mock.calls[0];
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  it('роутер выключен — обычный Haiku, роутер не вызывается', async () => {
    const create = jest.fn();
    const { service, streamSpy } = make({ create });
    await service.reply('сравни три последние встречи', [], { id: 'u1', role: 'OWNER' }, 'c1', 'm1');
    expect(create).not.toHaveBeenCalled();
    expect(streamSpy.mock.calls[0][0].model).toBe('claude-haiku-5-5');
  });

  it('роутер включён и сказал deep — ответ на Opus, решение в meta', async () => {
    const create = jest.fn().mockResolvedValue({ content: [{ type: 'tool_use', id: 't', name: 'route', input: { tier: 'deep', reason: 'сравнение встреч' } }], usage: {} });
    const { service, streamSpy, aiUsage } = make({ create, config: { ASSISTANT_ROUTER: 'on' } });
    await service.reply('сравни три последние встречи', [], { id: 'u1', role: 'OWNER' }, 'c1', 'm1');
    expect(create.mock.calls[0][0].tool_choice).toEqual({ type: 'tool', name: 'route' });
    expect(streamSpy.mock.calls[0][0].model).toBe('claude-opus-5-5');
    expect(aiUsage.record).toHaveBeenCalledWith(expect.objectContaining({ feature: 'assistant.reply', meta: { tier: 'deep', reason: 'сравнение встреч' } }));
  });

  it('роутер упал — обычный Haiku', async () => {
    const create = jest.fn().mockRejectedValue(new Error('overloaded'));
    const { service, streamSpy } = make({ create, config: { ASSISTANT_ROUTER: 'on' } });
    await service.reply('привет', [], { id: 'u1', role: 'OWNER' }, 'c1', 'm1');
    expect(streamSpy.mock.calls[0][0].model).toBe('claude-haiku-5-5');
  });
});

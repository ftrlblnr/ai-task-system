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
  return { id: 'u1', email: 'u1@example.com', role: Role.OWNER, isProfileAdmin: false, ...overrides };
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
  const service = new AssistantReplyService({} as any, tools as any) as any;
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
  // лишь один раз. MAX_TOOL_ROUNDS=3 разрешает до 3 раундов выполнения
  // инструментов (4 вызова streamOnce: 3 раунда tool_use + 1 финальный).
  it('MAX_TOOL_ROUNDS=3 — модель просит инструмент четвёртый раз подряд, цикл останавливается, texт берётся как есть', async () => {
    const { service, tools, streamOnce } = makeService(
      [
        toolUseMessage('get_recent_meetings', 'call-1'),
        toolUseMessage('get_recent_meetings', 'call-2'),
        toolUseMessage('get_recent_meetings', 'call-3'),
        toolUseMessage('get_recent_meetings', 'call-4'), // сверх лимита — не выполняется
      ],
      [
        { tool: 'get_recent_meetings', items: [], totalCount: 0 },
        { tool: 'get_recent_meetings', items: [], totalCount: 0 },
        { tool: 'get_recent_meetings', items: [], totalCount: 0 },
      ],
    );

    const result = await service.reply('Зациклись', [], user(), 'c1', 'm1');

    // 4 вызова streamOnce (раунды 1-4), но tools.execute — только 3 раза
    // (раунды 1-3); 4-й ответ модели с tool_use не выполняется, цикл
    // останавливается и берёт его (пустой) текст как есть.
    expect(streamOnce).toHaveBeenCalledTimes(4);
    expect(tools.execute).toHaveBeenCalledTimes(3);
    expect(result.toolCalls).toHaveLength(3);
  });

  // Раздел 15 спеки Phase O ("Meeting → Task workflow") — write-tool
  // (create_task_from_meeting) должен уметь быть ЛЮБЫМ раундом, включая
  // последний доступный (3-й) — runReply не делает разницы между read- и
  // write-инструментами, дальнейшая идемпотентность/валидация — целиком
  // внутри самого AssistantToolsService.execute (см. её тесты).
  it('write-tool create_task_from_meeting корректно выполняется на 3-м (последнем разрешённом) раунде, получает conversationId/userMessageId', async () => {
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
describe('AssistantReplyService.streamOnce — system-промпт (Stage 2, Phase O)', () => {
  it('передаёт в Anthropic system, объединяющий SYSTEM_PROMPT и buildDateContext()', async () => {
    const service = new AssistantReplyService({} as any, { buildTools: jest.fn() } as any) as any;
    const streamSpy = jest.fn().mockReturnValue({ on: jest.fn(), finalMessage: () => Promise.resolve({ content: [] }) });
    service.client = { messages: { stream: streamSpy } };

    await service.streamOnce([], [], undefined, undefined);

    const [payload] = streamSpy.mock.calls[0];
    expect(payload.system).toContain('ассистент корпоративной системы задач');
    expect(payload.system).toContain('create_task_from_meeting');
    expect(payload.system).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
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

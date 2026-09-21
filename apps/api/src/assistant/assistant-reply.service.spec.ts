import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantReplyService } from './assistant-reply.service';

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

    const result = await service.reply('Привет', [], user());

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

    const result = await service.reply('Найди встречу с Петром и процитируй про сроки', [], user());

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

    const result = await service.reply('Зациклись', [], user());

    // 4 вызова streamOnce (раунды 1-4), но tools.execute — только 3 раза
    // (раунды 1-3); 4-й ответ модели с tool_use не выполняется, цикл
    // останавливается и берёт его (пустой) текст как есть.
    expect(streamOnce).toHaveBeenCalledTimes(4);
    expect(tools.execute).toHaveBeenCalledTimes(3);
    expect(result.toolCalls).toHaveLength(3);
  });

  it('инструмент возвращает error — is_error попадает в tool_result, следующий раунд всё равно выполняется', async () => {
    const { service, tools } = makeService(
      [toolUseMessage('get_tasks', 'call-1'), textMessage('Не получилось получить задачи.')],
      [{ tool: 'get_tasks', error: true, message: 'db down' }],
    );

    const result = await service.reply('Покажи задачи', [], user());

    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(result.toolCalls[0].result).toEqual({ tool: 'get_tasks', error: true, message: 'db down' });
    expect(result.text).toBe('Не получилось получить задачи.');
  });
});

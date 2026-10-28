import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { VoiceService } from './voice.service';
import { generatedFileIds, looksLikeCommand, needsEscalation, VOICE_AGENT_CALL, VOICE_ESCALATION_CALL, voiceEngineFor } from './voice-agent';

// Единый агент A4 (docs/AGENT_AND_MEETINGS.md): голос и живой голос на том же
// AssistantReplyService, что текст, — за флагом VOICE_ENGINE.

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.OWNER, ...overrides };
}

describe('правила голоса на агенте', () => {
  it('агент — только при флаге и только руководству; сотрудник остаётся на прежнем разборе', () => {
    expect(voiceEngineFor('agent', true)).toBe('agent');
    expect(voiceEngineFor('agent', false)).toBe('legacy');
    expect(voiceEngineFor(undefined, true)).toBe('legacy');
    expect(voiceEngineFor('legacy', true)).toBe('legacy');
  });

  it('команда — по глаголу в начале слова, в любом месте фразы', () => {
    expect(looksLikeCommand('Поставь Рустему задачу на завтра')).toBe(true);
    expect(looksLikeCommand('перенеси встречу с Арманом на пятницу')).toBe(true);
    expect(looksLikeCommand('слушай, напомни Асель про отчёт')).toBe(true);
    expect(looksLikeCommand('что у меня завтра?')).toBe(false);
    expect(looksLikeCommand('какие задачи просрочены')).toBe(false);
  });

  it('эскалация — команда без инструментов и без встречного вопроса', () => {
    expect(needsEscalation('поставь задачу Ирине', { text: 'Хорошо.', toolCalls: [] })).toBe(true);
    expect(needsEscalation('поставь задачу', { text: 'Кому поставить?', toolCalls: [] })).toBe(false);
    expect(needsEscalation('что у меня завтра', { text: 'Две встречи.', toolCalls: [] })).toBe(false);
    expect(needsEscalation('поставь задачу Ирине', { text: 'Готово', toolCalls: [{ name: 'create_task', result: { tool: 'create_task', error: true, message: 'x' }, durationMs: 1 }] })).toBe(false);
  });

  it('сгенерированные файлы привязываются к сообщению', () => {
    expect(
      generatedFileIds({
        toolCalls: [
          { name: 'export_tasks_xlsx', result: { tool: 'export_tasks_xlsx', totalCount: 3, file: { fileId: 'f1', name: 'x.xlsx', mimeType: 'x', size: 1 } }, durationMs: 1 },
          { name: 'export_tasks_xlsx', result: { tool: 'export_tasks_xlsx', error: true, message: 'x' }, durationMs: 1 },
        ],
      }),
    ).toEqual(['f1']);
  });
});

describe('VoiceService на агенте (VOICE_ENGINE=agent)', () => {
  function setup(engine: string, replies: { text: string; toolCalls: unknown[] }[]) {
    const statuses: string[] = [];
    const prisma = {
      voiceExecution: {
        create: jest.fn().mockResolvedValue({ id: 'exec-1' }),
        update: jest.fn().mockImplementation(({ data }: { data: { status?: string } }) => {
          if (data.status) statuses.push(data.status);
          return Promise.resolve({});
        }),
      },
      message: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'um1', role: 'USER', parts: [], createdAt: new Date(), updatedAt: new Date(), status: 'COMPLETED', conversationId: 'c1' })
          .mockImplementationOnce(({ data }: { data: { parts: { create: unknown[] } } }) =>
            Promise.resolve({ id: 'am1', role: 'ASSISTANT', parts: data.parts.create.map((p, i) => ({ id: `p${i}`, ...(p as object) })), createdAt: new Date(), updatedAt: new Date(), status: 'COMPLETED', conversationId: 'c1' }),
          ),
      },
      mailActionItem: { findMany: jest.fn().mockResolvedValue([]) },
      mailDraft: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { update: jest.fn().mockResolvedValue({}) },
      fileArtifact: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const extraction = { extract: jest.fn() };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const chat = { assertOwnedConversation: jest.fn().mockResolvedValue(undefined), getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'c1' }) };
    const reply = { reply: jest.fn() };
    for (const r of replies) reply.reply.mockResolvedValueOnce(r);
    const config = { get: jest.fn().mockReturnValue(engine) };
    const service = new VoiceService(
      {} as any,
      extraction as any,
      prisma as any,
      audit as any,
      {} as any,
      {} as any,
      chat as any,
      {} as any,
      {} as any,
      reply as any,
      config as any,
    );
    return { service, prisma, extraction, reply, statuses, audit };
  }

  const taskCard = { taskId: 't1', title: 'Отчёт', status: 'NEW', dueDate: null, assignee: null, undoToken: 'undo-1', undoExpiresAt: '2026-10-28T10:00:30.000Z' };

  it('транскрипт идёт в агента, прежний разбор не вызывается; карточка с отменой — в ленте, results — один chat', async () => {
    const { service, extraction, reply, statuses, prisma } = setup('agent', [
      { text: 'Поставил задачу.', toolCalls: [{ name: 'create_task', result: { tool: 'create_task', task: taskCard }, durationMs: 5 }] },
    ]);

    const response = await service.parseTranscript(user(), { transcript: 'Поставь Рустему отчёт на завтра', clientRequestId: 'live:d1', conversationId: 'c1', liveContext: 'User: про отчёт' });

    expect(extraction.extract).not.toHaveBeenCalled();
    expect(reply.reply).toHaveBeenCalledTimes(1);
    const [turn, , , conversationId, userMessageId, , , call] = reply.reply.mock.calls[0];
    expect(turn).toContain('[live_context]');
    expect(turn).toContain('Поставь Рустему отчёт на завтра');
    expect(conversationId).toBe('c1');
    expect(userMessageId).toBe('exec-1');
    expect(call).toBe(VOICE_AGENT_CALL);
    expect(statuses).toEqual(['PROCESSING', 'EXECUTING', 'COMPLETED']);
    expect(response.results).toEqual([{ type: 'chat', reply: 'Поставил задачу.' }]);
    const parts = prisma.message.create.mock.calls[1][0].data.parts.create as { type: string; data: Record<string, unknown> }[];
    expect(parts.find((p) => p.type === 'TASK_CARD')?.data).toMatchObject({ undoToken: 'undo-1' });
    // В ленте сохраняется чистый транскрипт, без [live_context].
    expect(prisma.message.create.mock.calls[0][0].data.parts.create[0].data.content).toBe('Поставь Рустему отчёт на завтра');
  });

  it('команда без инструментов — повтор на Opus', async () => {
    const { service, reply } = setup('agent', [
      { text: 'Хорошо, сделаю.', toolCalls: [] },
      { text: 'Поставил задачу.', toolCalls: [{ name: 'create_task', result: { tool: 'create_task', task: taskCard }, durationMs: 5 }] },
    ]);
    const response = await service.parseTranscript(user(), { transcript: 'Поставь Рустему отчёт на завтра', clientRequestId: 'live:d2', conversationId: 'c1' });
    expect(reply.reply).toHaveBeenCalledTimes(2);
    expect(reply.reply.mock.calls[1][7]).toBe(VOICE_ESCALATION_CALL);
    expect(response.results).toEqual([{ type: 'chat', reply: 'Поставил задачу.' }]);
  });

  it('сбой агента — NEEDS_RECONCILIATION (он мог успеть что-то изменить), ошибка наружу', async () => {
    const { service, reply, statuses } = setup('agent', []);
    reply.reply.mockRejectedValueOnce(new Error('anthropic down'));
    await expect(service.parseTranscript(user(), { transcript: 'что у меня завтра', clientRequestId: 'live:d3', conversationId: 'c1' })).rejects.toThrow('anthropic down');
    expect(statuses).toEqual(['PROCESSING', 'EXECUTING', 'NEEDS_RECONCILIATION']);
  });

  it('сотрудник при включённом флаге — прежний разбор', async () => {
    const { service, extraction, reply } = setup('agent', []);
    extraction.extract.mockRejectedValueOnce(new Error('stop here'));
    await expect(service.parseTranscript(user({ role: Role.EMPLOYEE }), { transcript: 'поставь задачу', clientRequestId: 'live:d4', conversationId: 'c1' })).rejects.toThrow();
    expect(reply.reply).not.toHaveBeenCalled();
  });
});

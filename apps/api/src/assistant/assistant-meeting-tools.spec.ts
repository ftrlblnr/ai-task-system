import { ConflictException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AssistantToolsService, isWriteTool, toolResultForModel } from './assistant-tools.service';
import { toolActivityLabel, voiceActionCardParts } from './assistant-render';
import { parseApproveMeetingProposalsInput } from './meeting-tools';

// Поручения из встреч в чате (AGENT_AND_MEETINGS.md, B.5).

const OWNER = { id: 'owner', role: Role.OWNER } as never;
const EMPLOYEE = { id: 'emp', role: Role.EMPLOYEE } as never;

function proposal(order: number, status = 'PROPOSED', title = `Поручение ${order + 1}`) {
  return {
    id: `p${order + 1}`,
    order,
    status,
    version: 1,
    title,
    assignee: null,
    assigneeRawText: null,
    dueDate: null,
    confidence: 'HIGH',
    sourceContext: 'контекст',
    sourceTimestamp: null,
    similarTask: null,
  };
}

function make(opts: { proposals?: ReturnType<typeof proposal>[]; start?: jest.Mock; resolve?: jest.Mock } = {}) {
  const prisma = {
    competency: { findMany: jest.fn().mockResolvedValue([]) },
    agentActionExecution: { create: jest.fn().mockResolvedValue({ id: 'x1' }), update: jest.fn().mockResolvedValue({}) },
    employee: { findMany: jest.fn().mockResolvedValue([{ id: 'e1', fullName: 'Жандос Ахметов' }]) },
    task: {
      findMany: jest.fn().mockResolvedValue([{ id: 't1', title: 'Поручение 1', status: 'NEW', dueDate: null, assignee: null }]),
    },
  };
  const analysis = { start: opts.start ?? jest.fn().mockResolvedValue({ runId: 'run1', status: 'QUEUED', hadTranscript: true }) };
  const proposals = {
    list: jest.fn().mockResolvedValue({ run: { status: 'DONE', hadTranscript: true, error: null, inputChanged: false }, hasTranscript: true, proposals: opts.proposals ?? [proposal(0), proposal(1), proposal(2)] }),
    approve: jest.fn().mockResolvedValue({ results: [{ id: 'p1', status: 'APPROVED', taskId: 't1' }] }),
    reject: jest.fn().mockResolvedValue({ rejected: 1 }),
  };
  const resolver = { resolve: opts.resolve ?? jest.fn().mockResolvedValue({ status: 'RESOLVED', employeeId: 'e1' }) };
  const args: unknown[] = Array.from({ length: 19 }, () => undefined);
  args[0] = {};
  args[1] = {};
  args[2] = {};
  args[3] = {};
  args[4] = prisma;
  args[5] = { log: jest.fn() };
  args[6] = resolver;
  args[17] = analysis;
  args[18] = proposals;
  const service = new (AssistantToolsService as unknown as new (...a: unknown[]) => AssistantToolsService)(...args);
  return { service, prisma, analysis, proposals, resolver };
}

describe('инструменты поручений из встреч', () => {
  it('руководителю предлагаются, сотруднику — нет; пишущие — analyze и approve', async () => {
    const { service } = make();
    const owner = (await service.buildTools(OWNER)).map((t) => t.name);
    expect(owner).toEqual(expect.arrayContaining(['analyze_meeting', 'get_meeting_proposals', 'approve_meeting_proposals']));
    const employee = (await service.buildTools(EMPLOYEE)).map((t) => t.name);
    expect(employee).not.toContain('analyze_meeting');
    expect(employee).not.toContain('approve_meeting_proposals');
    expect(isWriteTool('analyze_meeting')).toBe(true);
    expect(isWriteTool('approve_meeting_proposals')).toBe(true);
    expect(isWriteTool('get_meeting_proposals')).toBe(false);
  });

  it('сотрудник не может вызвать даже из старой истории', async () => {
    const { service, proposals } = make();
    const result = await service.execute('approve_meeting_proposals', { meetingId: 'm1', approve: [1] }, EMPLOYEE, 'c1', 'u1', 0);
    expect(result).toMatchObject({ error: true, message: expect.stringContaining('FORBIDDEN') });
    expect(proposals.approve).not.toHaveBeenCalled();
  });

  it('analyze_meeting запускает разбор; идущий разбор — понятная ошибка', async () => {
    const { service, analysis } = make();
    await expect(service.execute('analyze_meeting', { meetingId: 'm1' }, OWNER, 'c1', 'u1', 0)).resolves.toEqual({
      tool: 'analyze_meeting',
      meetingId: 'm1',
      runId: 'run1',
      hadTranscript: true,
    });
    expect(analysis.start).toHaveBeenCalledWith('m1', 'owner');

    const busy = make({ start: jest.fn().mockRejectedValue(new ConflictException('ANALYSIS_IN_PROGRESS')) });
    await expect(busy.service.execute('analyze_meeting', { meetingId: 'm1' }, OWNER, 'c1', 'u1', 0)).resolves.toMatchObject({
      error: true,
      message: expect.stringContaining('ANALYSIS_IN_PROGRESS'),
    });
  });

  it('get_meeting_proposals — номера по порядку разбора', async () => {
    const { service } = make({ proposals: [proposal(0, 'APPROVED'), proposal(1)] });
    const result = await service.execute('get_meeting_proposals', { meetingId: 'm1' }, OWNER);
    expect(result).toMatchObject({ proposals: [{ n: 1, status: 'APPROVED' }, { n: 2, status: 'PROPOSED', title: 'Поручение 2' }] });
  });

  it('«утверди все, кроме третьего, срок Жандосу — среда»: номера → id, правки, отказ третьему', async () => {
    const { service, proposals, resolver } = make();
    const result = await service.execute(
      'approve_meeting_proposals',
      { meetingId: 'm1', approve: [1, 2], reject: [3], edits: [{ n: 2, assigneeRawText: 'Жандосу', dueDate: '2026-11-04' }] },
      OWNER,
      'c1',
      'u1',
      0,
    );
    expect(resolver.resolve).toHaveBeenCalledWith('Жандосу', [{ id: 'e1', fullName: 'Жандос Ахметов' }]);
    expect(proposals.approve).toHaveBeenCalledWith(
      'm1',
      [
        { id: 'p1', version: 1 },
        { id: 'p2', version: 1, assigneeId: 'e1', dueDate: '2026-11-04T13:00:00.000Z' },
      ],
      OWNER,
    );
    expect(proposals.reject).toHaveBeenCalledWith('m1', ['p3'], OWNER);
    expect(result).toMatchObject({ approved: [{ taskId: 't1', title: 'Поручение 1' }], rejected: 1, failed: [] });
  });

  it('номер не из ждущих решения — ничего не меняется', async () => {
    const { service, proposals } = make({ proposals: [proposal(0, 'APPROVED'), proposal(1)] });
    const result = await service.execute('approve_meeting_proposals', { meetingId: 'm1', approve: [1, 2] }, OWNER, 'c1', 'u1', 0);
    expect(result).toMatchObject({ error: true, message: expect.stringContaining('PROPOSAL_NOT_PENDING') });
    expect(proposals.approve).not.toHaveBeenCalled();
  });

  it('неоднозначное имя в правке — ничего не утверждено, вопрос пользователю', async () => {
    const { service, proposals } = make({ resolve: jest.fn().mockResolvedValue({ status: 'AMBIGUOUS', employeeId: null }) });
    const result = await service.execute(
      'approve_meeting_proposals',
      { meetingId: 'm1', approve: [1, 2], edits: [{ n: 2, assigneeRawText: 'Ирине' }] },
      OWNER,
      'c1',
      'u1',
      0,
    );
    expect(result).toMatchObject({ error: true, message: expect.stringContaining('ASSIGNEE_AMBIGUOUS') });
    expect(proposals.approve).not.toHaveBeenCalled();
  });
});

describe('поручения встреч — ответ модели и лента', () => {
  const approved = {
    tool: 'approve_meeting_proposals' as const,
    meetingId: 'm1',
    approved: [{ taskId: 't1', title: 'Смета', status: 'NEW', dueDate: null, assignee: null }],
    rejected: 1,
    failed: [{ n: 2, title: 'Договор', message: 'Исполнитель неактивен' }],
  };

  it('модели — счётчики и ошибки, пользователю — карточки задач и в голосе тоже', () => {
    expect(toolResultForModel(approved as never)).toMatchObject({ approvedCount: 1, approvedTitles: ['Смета'], rejected: 1 });
    expect(toolActivityLabel(approved as never).label).toBe('Поручения встречи: утверждено 1, отклонено 1, не получилось 1');
    const parts = voiceActionCardParts({ text: '', toolCalls: [{ result: approved }] } as never);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'TASK_CARD', data: { taskId: 't1' } });
  });
});

describe('parseApproveMeetingProposalsInput', () => {
  it('номера без повторов; одно и то же и в approve, и в reject — утверждение', () => {
    expect(parseApproveMeetingProposalsInput({ meetingId: ' m1 ', approve: [1, 1, '2', 0, -1], reject: [2, 3], edits: [{ n: 'x' }, { n: 2, title: ' Новое ' }] })).toEqual({
      meetingId: 'm1',
      approve: [1, 2],
      reject: [3],
      edits: [{ n: 2, title: 'Новое', assigneeRawText: undefined, dueDate: undefined }],
    });
  });
});

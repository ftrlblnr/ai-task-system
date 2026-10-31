import { NotFoundException } from '@nestjs/common';
import { MeetingProposalsService, proposalEdits } from './meeting-proposals.service';

const ACTOR = { id: 'owner', role: 'OWNER' } as never;
const PROPOSAL = {
  id: 'p1',
  meetingId: 'm1',
  title: 'Подготовить смету',
  description: null,
  assigneeId: 'e1',
  dueDate: new Date('2026-11-04T13:00:00Z'),
  priority: null,
  confidence: 'HIGH',
  sourceContext: 'Арман попросил смету к среде.',
  sourceSegmentId: 'seg-a',
  sourceTimestamp: '00:00',
};

function make(opts: { claimed?: number; current?: { status: string } | null; createFails?: boolean } = {}) {
  const updates: unknown[] = [];
  const prisma = {
    meetingProposal: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimed ?? 1 }),
      findFirst: jest.fn().mockResolvedValue(opts.current === undefined ? { status: 'PROPOSED' } : opts.current),
      findUniqueOrThrow: jest.fn().mockResolvedValue(PROPOSAL),
      update: jest.fn().mockImplementation((args: unknown) => (updates.push(args), Promise.resolve({}))),
    },
  };
  const tasks = { create: opts.createFails ? jest.fn().mockRejectedValue(new Error('Исполнитель неактивен')) : jest.fn().mockResolvedValue({ id: 't1' }) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new MeetingProposalsService(prisma as never, tasks as never, audit as never, {} as never);
  return { service, prisma, tasks, audit, updates };
}

describe('MeetingProposalsService.approve', () => {
  it('захват с проверкой версии → задача с источником и таймкодом → taskId в предложении', async () => {
    const { service, prisma, tasks, audit, updates } = make();
    const { results } = await service.approve('m1', [{ id: 'p1', version: 1 }], ACTOR);

    expect(prisma.meetingProposal.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', meetingId: 'm1', status: 'PROPOSED', version: 1 },
      data: expect.objectContaining({ status: 'APPROVED', version: { increment: 1 }, decidedById: 'owner' }),
    });
    expect(tasks.create).toHaveBeenCalledWith(
      {
        title: 'Подготовить смету',
        description: undefined,
        assigneeId: 'e1',
        priority: undefined,
        dueDate: '2026-11-04T13:00:00.000Z',
        sourceMeetingId: 'm1',
        sourceSegmentId: 'seg-a',
        sourceTimestamp: '00:00',
        sourceContext: 'Арман попросил смету к среде.',
        aiConfidence: 'HIGH',
      },
      ACTOR,
    );
    expect(updates).toEqual([{ where: { id: 'p1' }, data: { taskId: 't1' } }]);
    expect(results).toEqual([{ id: 'p1', status: 'APPROVED', taskId: 't1' }]);
    expect(audit.log).toHaveBeenCalledWith('owner', 'MEETING_PROPOSALS_APPROVED', 'Meeting', 'm1', { count: 1 });
  });

  it('устаревшая версия — VERSION_CONFLICT, задача не создаётся', async () => {
    const { service, tasks } = make({ claimed: 0, current: { status: 'PROPOSED' } });
    const { results } = await service.approve('m1', [{ id: 'p1', version: 1 }], ACTOR);
    expect(results).toEqual([expect.objectContaining({ id: 'p1', error: 'VERSION_CONFLICT' })]);
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('уже утверждено (второе нажатие) — ALREADY_DECIDED; чужое/нет — NOT_FOUND', async () => {
    const decided = make({ claimed: 0, current: { status: 'APPROVED' } });
    await expect(decided.service.approve('m1', [{ id: 'p1', version: 1 }], ACTOR)).resolves.toEqual({
      results: [expect.objectContaining({ error: 'ALREADY_DECIDED' })],
    });
    const missing = make({ claimed: 0, current: null });
    await expect(missing.service.approve('m1', [{ id: 'p1', version: 1 }], ACTOR)).resolves.toEqual({
      results: [expect.objectContaining({ error: 'NOT_FOUND' })],
    });
  });

  it('задача не создалась — поручение снова ждёт решения, ошибка в ответе, без 500', async () => {
    const { service, updates, audit } = make({ createFails: true });
    const { results } = await service.approve('m1', [{ id: 'p1', version: 1 }], ACTOR);
    expect(results).toEqual([{ id: 'p1', error: 'TASK_CREATE_FAILED', message: 'Исполнитель неактивен' }]);
    expect(updates).toEqual([{ where: { id: 'p1' }, data: { status: 'PROPOSED', decidedById: null, decidedAt: null } }]);
    expect(audit.log).not.toHaveBeenCalled();
  });
});

describe('proposalEdits', () => {
  it('только присланные поля; день из поля даты — 18:00 по Алматы; null снимает', () => {
    expect(proposalEdits({ id: 'p1', version: 1 })).toEqual({});
    expect(proposalEdits({ id: 'p1', version: 1, title: '  Смета ', assigneeId: null, dueDate: '2026-11-05' })).toEqual({
      title: 'Смета',
      assigneeId: null,
      dueDate: new Date('2026-11-05T13:00:00Z'),
    });
    expect(proposalEdits({ id: 'p1', version: 1, dueDate: null })).toEqual({ dueDate: null });
  });
});

describe('MeetingProposalsService.reject / list', () => {
  it('отклоняет только ждущие решения этой встречи', async () => {
    const { service, prisma, audit } = make();
    await expect(service.reject('m1', ['p1', 'p2'], ACTOR)).resolves.toEqual({ rejected: 1 });
    expect(prisma.meetingProposal.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2'] }, meetingId: 'm1', status: 'PROPOSED' },
      data: expect.objectContaining({ status: 'REJECTED', decidedById: 'owner' }),
    });
    expect(audit.log).toHaveBeenCalledWith('owner', 'MEETING_PROPOSALS_REJECTED', 'Meeting', 'm1', { count: 1 });
  });

  it('список — предложения последнего успешного разбора', async () => {
    const prisma = {
      meeting: { findUnique: jest.fn().mockResolvedValue({ id: 'm1' }) },
      meetingAnalysisRun: { findFirst: jest.fn().mockResolvedValue({ id: 'run-done' }) },
      meetingSegment: { count: jest.fn().mockResolvedValue(0) },
      meetingProposal: { findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]) },
    };
    const analysis = { latest: jest.fn().mockResolvedValue({ runId: 'run-new', status: 'RUNNING' }) };
    const service = new MeetingProposalsService(prisma as never, {} as never, {} as never, analysis as never);
    await expect(service.list('m1')).resolves.toEqual({ run: { runId: 'run-new', status: 'RUNNING' }, hasTranscript: false, proposals: [{ id: 'p1' }] });
    expect(prisma.meetingProposal.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { runId: 'run-done' } }));
  });

  it('нет встречи — 404', async () => {
    const prisma = { meeting: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new MeetingProposalsService(prisma as never, {} as never, {} as never, {} as never);
    await expect(service.list('m1')).rejects.toThrow(NotFoundException);
  });
});

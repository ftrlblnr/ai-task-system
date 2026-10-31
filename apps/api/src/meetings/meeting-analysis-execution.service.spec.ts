import { InternalServerErrorException } from '@nestjs/common';
import { MAX_ANALYSIS_ATTEMPTS, MeetingAnalysisExecutionService, toProposalRows } from './meeting-analysis-execution.service';

const RUN = { id: 'run2', meetingId: 'm1', requestedById: 'u1', attempts: 1 } as never;
const DRAFT = {
  title: 'Подготовить смету',
  description: null,
  assigneeId: 'e1',
  dueDate: '2026-11-04T18:00:00+05:00',
  priority: null,
  confidence: 'HIGH' as const,
  sourceContext: 'Жандос подготовит смету к среде.',
};

function make(extract: jest.Mock, opts: { meeting?: boolean; auditFails?: boolean } = {}) {
  const calls: { op: string; args: unknown }[] = [];
  const record = (op: string) => jest.fn().mockImplementation((args: unknown) => (calls.push({ op, args }), Promise.resolve({ count: 0 })));
  const tx = {
    meetingProposal: { updateMany: record('supersede'), createMany: record('create') },
    meetingAnalysisRun: { update: record('done') },
  };
  const prisma = {
    meeting: { findUnique: jest.fn().mockResolvedValue(opts.meeting === false ? null : { title: 'Планёрка', meetingDate: new Date('2026-11-02T04:00:00Z') }) },
    employee: { findMany: jest.fn().mockResolvedValue([{ id: 'e1', fullName: 'Жандос Ахметов' }]) },
    meetingAnalysisRun: { updateMany: record('fail') },
    $transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const analysis = { loadInput: jest.fn().mockResolvedValue({ summary: 'Саммари', segments: [] }) };
  const audit = { log: opts.auditFails ? jest.fn().mockRejectedValue(new Error('db')) : jest.fn().mockResolvedValue(undefined) };
  const service = new MeetingAnalysisExecutionService(prisma as never, audit as never, analysis as never, { extract } as never);
  return { service, calls, audit };
}

describe('MeetingAnalysisExecutionService.process', () => {
  it('успех: прежние неутверждённые заменяются, новые предложения и DONE — одной транзакцией', async () => {
    const extract = jest.fn().mockResolvedValue([DRAFT]);
    const { service, calls, audit } = make(extract);
    await service.process(RUN);

    expect(extract).toHaveBeenCalledWith('Саммари', 'Планёрка', expect.any(String), [{ id: 'e1', fullName: 'Жандос Ахметов' }]);
    expect(calls.map((c) => c.op)).toEqual(['supersede', 'create', 'done']);
    // Только PROPOSED прошлых запусков — решения руководителя не трогаем.
    expect(calls[0].args).toEqual({
      where: { meetingId: 'm1', runId: { not: 'run2' }, status: 'PROPOSED' },
      data: { status: 'SUPERSEDED' },
    });
    expect(calls[2].args).toMatchObject({ where: { id: 'run2' }, data: { status: 'DONE', lockedAt: null } });
    expect(audit.log).toHaveBeenCalledWith('u1', 'AI_MEETING_EXTRACT', 'Meeting', 'm1', { runId: 'run2', proposalCount: 1 });
  });

  it('поручений нет — DONE без строк предложений', async () => {
    const { service, calls } = make(jest.fn().mockResolvedValue([]));
    await service.process(RUN);
    expect(calls.map((c) => c.op)).toEqual(['supersede', 'done']);
  });

  it('сбой аудита после DONE не возвращает запуск в очередь', async () => {
    const { service, calls } = make(jest.fn().mockResolvedValue([DRAFT]), { auditFails: true });
    await service.process(RUN);
    expect(calls.some((c) => c.op === 'fail')).toBe(false);
  });

  it('сбой сети на первой попытке — обратно в очередь', async () => {
    const { service, calls } = make(jest.fn().mockRejectedValue(new Error('ECONNRESET')));
    await service.process(RUN);
    expect(calls).toEqual([{ op: 'fail', args: expect.objectContaining({ data: expect.objectContaining({ status: 'QUEUED', lockedAt: null }) }) }]);
  });

  it('последняя попытка — FAILED', async () => {
    const { service, calls } = make(jest.fn().mockRejectedValue(new Error('ECONNRESET')));
    await service.process({ ...(RUN as object), attempts: MAX_ANALYSIS_ATTEMPTS } as never);
    expect(calls[0].args).toMatchObject({ data: { status: 'FAILED', error: expect.stringContaining('Не удалось разобрать') } });
  });

  it('понятная ошибка извлечения — сразу FAILED с её текстом', async () => {
    const err = new InternalServerErrorException('Встреча слишком длинная: список задач не поместился в ответ модели');
    const { service, calls } = make(jest.fn().mockRejectedValue(err));
    await service.process(RUN);
    expect(calls[0].args).toMatchObject({ data: { status: 'FAILED', error: 'Встреча слишком длинная: список задач не поместился в ответ модели' } });
  });

  it('встречу удалили, пока запуск ждал, — ничего не пишем', async () => {
    const extract = jest.fn();
    const { service, calls } = make(extract, { meeting: false });
    await service.process(RUN);
    expect(extract).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe('toProposalRows', () => {
  it('порядок, дата срока, неразборчивая дата → null', () => {
    const rows = toProposalRows('m1', 'r1', [DRAFT, { ...DRAFT, title: 'Второе', dueDate: 'в среду' }]);
    expect(rows[0]).toMatchObject({ meetingId: 'm1', runId: 'r1', order: 0, assigneeId: 'e1', dueDate: new Date('2026-11-04T13:00:00Z') });
    expect(rows[1]).toMatchObject({ order: 1, dueDate: null });
  });
});

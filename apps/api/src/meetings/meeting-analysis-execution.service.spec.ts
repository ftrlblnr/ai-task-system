import { InternalServerErrorException } from '@nestjs/common';
import { MAX_ANALYSIS_ATTEMPTS, MeetingAnalysisExecutionService, toProposalRows } from './meeting-analysis-execution.service';

const RUN = { id: 'run2', meetingId: 'm1', requestedById: 'u1', attempts: 1 } as never;
const DRAFT = {
  title: 'Подготовить смету',
  description: null,
  assigneeId: 'e1',
  assigneeRawText: 'Жандос',
  dueDate: new Date('2026-11-04T13:00:00Z'),
  priority: null,
  confidence: 'HIGH' as const,
  sourceContext: 'Жандос подготовит смету к среде.',
  segmentId: 'seg-a',
  sourceTimestamp: '00:00',
};

const SEGMENTS = [
  { speakerLabel: 'Speaker 1', startMs: 0, text: 'Жандос, подготовь смету к среде.' },
  { speakerLabel: 'Speaker 2', startMs: 4000, text: 'Хорошо, подготовлю.' },
];
const MEETING = {
  title: 'Планёрка',
  meetingDate: new Date('2026-11-02T04:00:00Z'),
  createdById: 'owner',
  speakerNames: null,
  createdBy: { fullName: 'Арман Ким' },
};

function suggestion(label: string, name: string | null, confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH') {
  return { label, employeeId: null, name, confidence, applied: false };
}

interface Opts {
  meeting?: Record<string, unknown> | null;
  // Имена, которые «вписал руководитель», пока модель сопоставляла говорящих.
  freshSpeakerNames?: unknown;
  segments?: typeof SEGMENTS;
  suggest?: jest.Mock;
  auditFails?: boolean;
}

function make(extract: jest.Mock, opts: Opts = {}) {
  const calls: { op: string; args: unknown }[] = [];
  const record = (op: string) => jest.fn().mockImplementation((args: unknown) => (calls.push({ op, args }), Promise.resolve({ count: 0 })));
  const tx = {
    meetingProposal: { updateMany: record('supersede'), createMany: record('create') },
    meetingAnalysisRun: { update: record('done') },
  };
  const meeting = opts.meeting === undefined ? MEETING : opts.meeting;
  const prisma = {
    meeting: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce(meeting)
        .mockResolvedValue(meeting && { speakerNames: opts.freshSpeakerNames ?? null }),
    },
    meetingSegment: { findMany: jest.fn().mockResolvedValue(opts.segments ?? []) },
    employee: { findMany: jest.fn().mockResolvedValue([{ id: 'e1', fullName: 'Жандос Ахметов' }]) },
    task: { findMany: jest.fn().mockResolvedValue([{ id: 't1', title: 'Подготовить смету', assigneeId: 'e1', sourceMeetingId: null }]) },
    meetingAnalysisRun: { updateMany: record('fail') },
    $transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const analysis = { loadInput: jest.fn().mockResolvedValue({ summary: 'Саммари', segments: [] }) };
  const audit = { log: opts.auditFails ? jest.fn().mockRejectedValue(new Error('db')) : jest.fn().mockResolvedValue(undefined) };
  const meetings = { updateSpeakers: jest.fn().mockResolvedValue({}) };
  const speakers = { suggest: opts.suggest ?? jest.fn().mockResolvedValue([]) };
  const service = new MeetingAnalysisExecutionService(
    prisma as never,
    audit as never,
    analysis as never,
    { extract } as never,
    meetings as never,
    speakers as never,
  );
  return { service, calls, audit, meetings, speakers };
}

function doneData(calls: { op: string; args: unknown }[]) {
  return (calls.find((c) => c.op === 'done')?.args as { data: Record<string, unknown> }).data;
}

describe('MeetingAnalysisExecutionService.process', () => {
  it('успех: прежние неутверждённые заменяются, новые предложения и DONE — одной транзакцией', async () => {
    const extract = jest.fn().mockResolvedValue([DRAFT]);
    const { service, calls, audit } = make(extract);
    await service.process(RUN);

    expect(extract).toHaveBeenCalledWith({
      meetingTitle: 'Планёрка',
      meetingDate: MEETING.meetingDate,
      summary: 'Саммари',
      transcript: [],
      ownerName: 'Арман Ким',
      employees: [{ id: 'e1', fullName: 'Жандос Ахметов' }],
    });
    expect(calls.map((c) => c.op)).toEqual(['supersede', 'create', 'done']);
    // Уже есть такая же открытая задача у того же исполнителя — помечена.
    expect(calls[1].args).toEqual({ data: [expect.objectContaining({ similarTaskId: 't1', sourceSegmentId: 'seg-a', sourceTimestamp: '00:00' })] });
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
    const { service, calls } = make(extract, { meeting: null });
    await service.process(RUN);
    expect(extract).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe('MeetingAnalysisExecutionService — шаг «говорящие»', () => {
  const extract = () => jest.fn().mockResolvedValue([]);

  it('все метки HIGH и разные имена — применяются сами, подсказки помечены applied', async () => {
    const suggest = jest.fn().mockResolvedValue([suggestion('Speaker 1', 'Арман Ким'), suggestion('Speaker 2', 'Жандос Ахметов')]);
    const { service, calls, meetings } = make(extract(), { segments: SEGMENTS, suggest });
    await service.process(RUN);
    expect(meetings.updateSpeakers).toHaveBeenCalledWith('m1', { 'Speaker 1': 'Арман Ким', 'Speaker 2': 'Жандос Ахметов' });
    expect(doneData(calls).speakerSuggestions).toEqual([
      expect.objectContaining({ label: 'Speaker 1', applied: true }),
      expect.objectContaining({ label: 'Speaker 2', applied: true }),
    ]);
  });

  it('хоть одна метка не HIGH — только подсказки, имена не трогаем', async () => {
    const suggest = jest.fn().mockResolvedValue([suggestion('Speaker 1', 'Арман Ким'), suggestion('Speaker 2', 'Жандос Ахметов', 'MEDIUM')]);
    const { service, calls, meetings } = make(extract(), { segments: SEGMENTS, suggest });
    await service.process(RUN);
    expect(meetings.updateSpeakers).not.toHaveBeenCalled();
    expect(doneData(calls).speakerSuggestions).toEqual([
      expect.objectContaining({ applied: false }),
      expect.objectContaining({ applied: false }),
    ]);
  });

  it('имена уже заданы человеком — шаг пропускается, модель не вызывается', async () => {
    const suggest = jest.fn();
    const { service, meetings } = make(extract(), { meeting: { ...MEETING, speakerNames: { 'Speaker 1': 'Арман Ким' } }, segments: SEGMENTS, suggest });
    await service.process(RUN);
    expect(suggest).not.toHaveBeenCalled();
    expect(meetings.updateSpeakers).not.toHaveBeenCalled();
  });

  it('руководитель вписал имена, пока шёл разбор, — его ввод не перезаписывается', async () => {
    const suggest = jest.fn().mockResolvedValue([suggestion('Speaker 1', 'Арман Ким'), suggestion('Speaker 2', 'Жандос Ахметов')]);
    const { service, meetings } = make(extract(), { segments: SEGMENTS, suggest, freshSpeakerNames: { 'Speaker 2': 'Ирина' } });
    await service.process(RUN);
    expect(meetings.updateSpeakers).not.toHaveBeenCalled();
  });

  it('нет расшифровки — шаг пропускается', async () => {
    const suggest = jest.fn();
    const { service, calls } = make(extract(), { suggest });
    await service.process(RUN);
    expect(suggest).not.toHaveBeenCalled();
    expect(doneData(calls).speakerSuggestions).toBeDefined();
  });

  it('сбой сопоставления не мешает извлечению поручений', async () => {
    const ex = jest.fn().mockResolvedValue([DRAFT]);
    const { service, calls } = make(ex, { segments: SEGMENTS, suggest: jest.fn().mockRejectedValue(new Error('overloaded')) });
    await service.process(RUN);
    expect(ex).toHaveBeenCalled();
    expect(calls.map((c) => c.op)).toEqual(['supersede', 'create', 'done']);
  });
});

describe('toProposalRows', () => {
  it('порядок, источник, похожая задача только при совпадении', () => {
    const rows = toProposalRows('m1', 'r1', [DRAFT, { ...DRAFT, title: 'Согласовать договор', segmentId: null, sourceTimestamp: null }], [
      { id: 't1', title: 'Подготовить смету', assigneeId: 'e1', sourceMeetingId: null },
    ]);
    expect(rows[0]).toMatchObject({ meetingId: 'm1', runId: 'r1', order: 0, assigneeRawText: 'Жандос', sourceSegmentId: 'seg-a', similarTaskId: 't1' });
    expect(rows[1]).toMatchObject({ order: 1, sourceSegmentId: null, similarTaskId: null });
  });
});

import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { analysisInputHash, MeetingAnalysisService } from './meeting-analysis.service';

const MEETING = { rawSummary: 'Исходное', latestSummary: null, enhancedSummary: 'С именами' };
const SEGMENTS = [
  { id: 's1', text: 'Жандос, подготовь смету к среде.' },
  { id: 's2', text: 'Хорошо.' },
];

function make(opts: { meeting?: typeof MEETING | null; segments?: typeof SEGMENTS; active?: boolean; runs?: Record<string, unknown>[] } = {}) {
  const created: Record<string, unknown>[] = [];
  const runs = opts.runs ?? [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'm1' }]),
    meetingAnalysisRun: {
      findFirst: jest.fn().mockResolvedValue(opts.active ? { id: 'busy' } : null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: 'run1', status: 'QUEUED', hadTranscript: data.hadTranscript });
      }),
    },
  };
  const prisma = {
    meeting: { findUnique: jest.fn().mockResolvedValue(opts.meeting === undefined ? MEETING : opts.meeting) },
    meetingSegment: { findMany: jest.fn().mockResolvedValue(opts.segments ?? SEGMENTS) },
    meetingAnalysisRun: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { status?: string } }) =>
        Promise.resolve(runs.find((r) => !where.status || r.status === where.status) ?? null),
      ),
    },
    $transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { service: new MeetingAnalysisService(prisma as never), created, tx };
}

describe('MeetingAnalysisService.start', () => {
  it('ставит запуск в очередь с хэшем входа и признаком расшифровки', async () => {
    const { service, created, tx } = make();
    await expect(service.start('m1', 'u1')).resolves.toEqual({ runId: 'run1', status: 'QUEUED', hadTranscript: true });
    expect(created[0]).toEqual({
      meetingId: 'm1',
      requestedById: 'u1',
      inputHash: analysisInputHash({ summary: 'С именами', segments: SEGMENTS }),
      hadTranscript: true,
    });
    // Строка встречи блокируется до проверки идущего разбора.
    expect(tx.$queryRaw).toHaveBeenCalled();
  });

  it('без расшифровки — разбор по саммари, hadTranscript: false', async () => {
    const { service } = make({ segments: [] });
    await expect(service.start('m1', 'u1')).resolves.toMatchObject({ hadTranscript: false });
  });

  it('разбор уже идёт — 409, второй запуск не создаётся', async () => {
    const { service, created } = make({ active: true });
    await expect(service.start('m1', 'u1')).rejects.toThrow(ConflictException);
    expect(created).toHaveLength(0);
  });

  it('нет ни саммари, ни расшифровки — 422', async () => {
    const { service } = make({ meeting: { ...MEETING, enhancedSummary: '  ' }, segments: [] });
    await expect(service.start('m1', 'u1')).rejects.toThrow(UnprocessableEntityException);
  });

  it('нет встречи — 404', async () => {
    const { service } = make({ meeting: null });
    await expect(service.start('m1', 'u1')).rejects.toThrow(NotFoundException);
  });
});

describe('MeetingAnalysisService.latest', () => {
  const hash = analysisInputHash({ summary: 'С именами', segments: SEGMENTS });

  it('ещё не запускали — null', async () => {
    const { service } = make();
    await expect(service.latest('m1')).resolves.toBeNull();
  });

  it('запись не менялась с последнего DONE — inputChanged: false', async () => {
    const { service } = make({ runs: [{ id: 'r1', status: 'DONE', inputHash: hash, hadTranscript: true, error: null }] });
    await expect(service.latest('m1')).resolves.toMatchObject({ runId: 'r1', status: 'DONE', inputChanged: false });
  });

  it('Plaud дописал расшифровку после разбора — inputChanged: true', async () => {
    const old = analysisInputHash({ summary: 'С именами', segments: [] });
    const { service } = make({ runs: [{ id: 'r1', status: 'DONE', inputHash: old, hadTranscript: false, error: null }] });
    await expect(service.latest('m1')).resolves.toMatchObject({ inputChanged: true });
  });

  it('последний запуск упал — сравнение с предыдущим DONE', async () => {
    const { service } = make({
      runs: [
        { id: 'r2', status: 'FAILED', inputHash: 'x', hadTranscript: true, error: 'Не удалось' },
        { id: 'r1', status: 'DONE', inputHash: hash, hadTranscript: true, error: null },
      ],
    });
    await expect(service.latest('m1')).resolves.toMatchObject({ runId: 'r2', status: 'FAILED', error: 'Не удалось', inputChanged: false });
  });
});

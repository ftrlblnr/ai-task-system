import { MeetingsService } from './meetings.service';

// Находка №7 пятого внешнего аудита (Stage 2, Phase L) —
// MeetingSegment.speakerEmployeeId существовал в схеме с Phase K, но ничем
// не заполнялся (грепом подтверждено — ни одного присвоения нигде в коде).
// updateSpeakers — единственное место, где руководитель уже вводит
// сопоставление "Speaker N" -> реальное имя (для enhancedSummary), поэтому
// именно здесь резолвим speakerEmployeeId, тем же EmployeeResolverService,
// что уже проверен в employee-resolver.service.spec.ts (сам резолвер здесь
// не перепроверяется — только то, что MeetingsService правильно его
// вызывает и правильно пишет результат в MeetingSegment).

function makeDeps(overrides: { employees?: { id: string; fullName: string }[]; resolutions?: Record<string, { status: string; employeeId: string | null }> } = {}) {
  const employees = overrides.employees ?? [{ id: 'e1', fullName: 'Иван Петров' }];
  const resolutions = overrides.resolutions ?? {};
  const prisma = {
    meeting: {
      findUnique: jest.fn().mockResolvedValue({ rawSummary: 'Саммари' }),
      update: jest.fn().mockResolvedValue({ id: 'm1' }),
    },
    employee: { findMany: jest.fn().mockResolvedValue(employees) },
    meetingSegment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const speakerSubstitution = { substitute: jest.fn().mockResolvedValue('Обновлённое саммари') };
  const employeeResolver = {
    resolve: jest.fn().mockImplementation((name: string) => Promise.resolve(resolutions[name] ?? { status: 'NOT_FOUND', employeeId: null })),
  };
  const service = new MeetingsService(prisma as any, {} as any, {} as any, {} as any, speakerSubstitution as any, employeeResolver as any);
  return { service, prisma, speakerSubstitution, employeeResolver };
}

describe('MeetingsService.updateSpeakers — сопоставление спикеров с сотрудниками (Stage 2, Phase L)', () => {
  it('имя резолвится (RESOLVED) — MeetingSegment.updateMany вызывается с найденным employeeId', async () => {
    const { service, prisma, employeeResolver } = makeDeps({
      resolutions: { 'Иван Петров': { status: 'RESOLVED', employeeId: 'e1' } },
    });

    await service.updateSpeakers('m1', { 'Speaker 1': 'Иван Петров' });

    expect(employeeResolver.resolve).toHaveBeenCalledWith('Иван Петров', [{ id: 'e1', fullName: 'Иван Петров' }]);
    expect(prisma.meetingSegment.updateMany).toHaveBeenCalledWith({
      where: { meetingId: 'm1', speakerLabel: 'Speaker 1' },
      data: { speakerEmployeeId: 'e1' },
    });
  });

  it('имя не резолвится (NOT_FOUND/AMBIGUOUS) — MeetingSegment не трогается, updateSpeakers всё равно успешен', async () => {
    const { service, prisma } = makeDeps(); // resolutions по умолчанию NOT_FOUND

    const result = await service.updateSpeakers('m1', { 'Speaker 1': 'Внешний гость' });

    expect(prisma.meetingSegment.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'm1' });
  });

  it('несколько говорящих — каждый резолвится и обновляется независимо', async () => {
    const { service, prisma } = makeDeps({
      employees: [
        { id: 'e1', fullName: 'Иван Петров' },
        { id: 'e2', fullName: 'Жанна Смирнова' },
      ],
      resolutions: {
        'Иван Петров': { status: 'RESOLVED', employeeId: 'e1' },
        'Жанна Смирнова': { status: 'RESOLVED', employeeId: 'e2' },
      },
    });

    await service.updateSpeakers('m1', { 'Speaker 1': 'Иван Петров', 'Speaker 2': 'Жанна Смирнова' });

    expect(prisma.meetingSegment.updateMany).toHaveBeenCalledWith({ where: { meetingId: 'm1', speakerLabel: 'Speaker 1' }, data: { speakerEmployeeId: 'e1' } });
    expect(prisma.meetingSegment.updateMany).toHaveBeenCalledWith({ where: { meetingId: 'm1', speakerLabel: 'Speaker 2' }, data: { speakerEmployeeId: 'e2' } });
  });

  it('сбой резолва спикеров (best-effort) не мешает основному ответу updateSpeakers', async () => {
    const { service, prisma, employeeResolver } = makeDeps();
    employeeResolver.resolve.mockRejectedValue(new Error('db down'));

    await expect(service.updateSpeakers('m1', { 'Speaker 1': 'Иван Петров' })).resolves.toEqual({ id: 'm1' });

    expect(prisma.meeting.update).toHaveBeenCalled();
  });

  it('пустой speakerNames — резолвер не вызывается вовсе', async () => {
    const { service, employeeResolver } = makeDeps();

    await service.updateSpeakers('m1', {});

    expect(employeeResolver.resolve).not.toHaveBeenCalled();
  });
});

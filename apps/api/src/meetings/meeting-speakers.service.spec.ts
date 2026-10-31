import { buildSpeakerExcerpts, hasSpeakerNames, MeetingSpeakersService, shouldAutoApply, type SpeakerSuggestion } from './meeting-speakers.service';

function s(label: string, name: string | null, confidence: SpeakerSuggestion['confidence'] = 'HIGH'): SpeakerSuggestion {
  return { label, employeeId: null, name, confidence, applied: false };
}

describe('shouldAutoApply', () => {
  const labels = ['Speaker 1', 'Speaker 2'];

  it('все HIGH, имена различны — да', () => {
    expect(shouldAutoApply(labels, [s('Speaker 1', 'Арман Ким'), s('Speaker 2', 'Жандос Ахметов')])).toBe(true);
  });

  it('одна метка MEDIUM — нет', () => {
    expect(shouldAutoApply(labels, [s('Speaker 1', 'Арман Ким'), s('Speaker 2', 'Жандос Ахметов', 'MEDIUM')])).toBe(false);
  });

  it('метка без имени или пропущена — нет', () => {
    expect(shouldAutoApply(labels, [s('Speaker 1', 'Арман Ким'), s('Speaker 2', null)])).toBe(false);
    expect(shouldAutoApply(labels, [s('Speaker 1', 'Арман Ким')])).toBe(false);
  });

  it('одно имя на две метки — нет', () => {
    expect(shouldAutoApply(labels, [s('Speaker 1', 'Арман Ким'), s('Speaker 2', 'арман  ким')])).toBe(false);
  });
});

describe('hasSpeakerNames', () => {
  it('пустые значения не считаются заданными именами', () => {
    expect(hasSpeakerNames(null)).toBe(false);
    expect(hasSpeakerNames({ 'Speaker 1': '  ' })).toBe(false);
    expect(hasSpeakerNames({ 'Speaker 1': '', 'Speaker 2': 'Ирина' })).toBe(true);
  });
});

describe('buildSpeakerExcerpts', () => {
  it('реплики по меткам в порядке появления, с таймкодом, не больше 12 на метку', () => {
    const segments = [
      { speakerLabel: 'Speaker 2', startMs: 65_000, text: 'Начнём.' },
      ...Array.from({ length: 15 }, (_, i) => ({ speakerLabel: 'Speaker 1', startMs: 70_000 + i * 1000, text: `Реплика ${i}` })),
    ];
    const text = buildSpeakerExcerpts(segments);
    expect(text.indexOf('## Speaker 2')).toBeLessThan(text.indexOf('## Speaker 1'));
    expect(text).toContain('01:05 Начнём.');
    expect(text).toContain('Реплика 11');
    expect(text).not.toContain('Реплика 12');
  });
});

describe('MeetingSpeakersService.suggest', () => {
  const SEGMENTS = [
    { speakerLabel: 'Speaker 1', startMs: 0, text: 'Жандос, подготовь смету.' },
    { speakerLabel: 'Speaker 2', startMs: 3000, text: 'Сделаю.' },
  ];
  const EMPLOYEES = [
    { id: 'owner', fullName: 'Арман Ким', aliases: [] },
    { id: 'e2', fullName: 'Жандос Ахметов', aliases: [{ alias: 'Жандик' }] },
    { id: 'e3', fullName: 'Ирина Иванова', aliases: [] },
  ];

  function make(speakers: unknown, resolve: jest.Mock) {
    const prisma = {
      employee: { findMany: jest.fn().mockResolvedValue(EMPLOYEES) },
      event: { findMany: jest.fn().mockResolvedValue([{ participants: [{ employeeId: 'e2' }, { employeeId: 'owner' }] }]) },
    };
    const create = jest.fn().mockResolvedValue({ content: [{ type: 'tool_use', name: 'map_speakers', input: { speakers } }] });
    const service = new MeetingSpeakersService(prisma as never, {} as never, { resolve } as never);
    (service as unknown as { client: unknown }).client = { messages: { create } };
    return { service, create };
  }

  it('кандидаты из календаря выше остальных; сотрудник — полным именем; внешний — как прозвучал', async () => {
    const resolve = jest.fn().mockImplementation((name: string) =>
      Promise.resolve(name === 'Жандос' ? { status: 'RESOLVED', employeeId: 'e2' } : { status: 'NOT_FOUND', employeeId: null }),
    );
    const { service, create } = make(
      [
        { label: 'Speaker 1', name: 'Самат (подрядчик)', confidence: 'MEDIUM' },
        { label: 'Speaker 2', name: 'Жандос', confidence: 'HIGH' },
        { label: 'Speaker 9', name: 'Ирина', confidence: 'HIGH' },
      ],
      resolve,
    );
    const result = await service.suggest({ title: 'Планёрка', meetingDate: new Date('2026-11-02T04:00:00Z'), createdById: 'owner' }, SEGMENTS);

    const system = (create.mock.calls[0][0] as { system: string }).system;
    expect(system.indexOf('Жандос Ахметов (зовут также: Жандик)')).toBeLessThan(system.indexOf('Остальные сотрудники'));
    expect(system.indexOf('Ирина Иванова')).toBeGreaterThan(system.indexOf('Остальные сотрудники'));
    expect(system).toContain('Запись сделал(а) Арман Ким');

    expect(result).toEqual([
      { label: 'Speaker 1', employeeId: null, name: 'Самат (подрядчик)', confidence: 'MEDIUM', applied: false },
      { label: 'Speaker 2', employeeId: 'e2', name: 'Жандос Ахметов', confidence: 'HIGH', applied: false },
    ]);
  });

  it('нет реплик — без вызова модели', async () => {
    const { service, create } = make([], jest.fn());
    await expect(service.suggest({ title: 'x', meetingDate: new Date(), createdById: 'owner' }, [])).resolves.toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

import {
  formatTranscriptLine,
  mergeProposals,
  MeetingTaskExtractionService,
  parseLocalDue,
  splitTranscript,
  type MeetingExtractionInput,
} from './meeting-task-extraction.service';

const EMPLOYEES = [
  { id: 'e1', fullName: 'Жандос Ахметов' },
  { id: 'e2', fullName: 'Арман Ким' },
];

function input(overrides: Partial<MeetingExtractionInput> = {}): MeetingExtractionInput {
  return {
    meetingTitle: 'Планёрка',
    // 01:00 по Алматы 02.11 — по UTC ещё 01.11.
    meetingDate: new Date('2026-11-01T20:00:00Z'),
    summary: 'Обсудили смету.',
    transcript: [
      { segmentId: 'seg-a', startMs: 0, speaker: 'Арман Ким', text: 'Жандос, подготовь смету к среде.' },
      { segmentId: 'seg-b', startMs: 75_000, speaker: 'Жандос Ахметов', text: 'Сделаю.' },
    ],
    ownerName: 'Арман Ким',
    employees: EMPLOYEES,
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Подготовить смету',
    description: null,
    assigneeRawText: 'Жандос',
    dueDate: '2026-11-04',
    priority: null,
    confidence: 'HIGH',
    sourceContext: 'Арман попросил подготовить смету к среде.',
    ref: 'S1',
    ...overrides,
  };
}

function make(responses: object[], resolve = jest.fn().mockResolvedValue({ status: 'RESOLVED', employeeId: 'e1' })) {
  const create = jest.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  const service = new MeetingTaskExtractionService({ getOrThrow: () => 'key' } as never, { resolve } as never);
  (service as unknown as { client: unknown }).client = { messages: { create } };
  return { service, create, resolve };
}

const toolResponse = (tasks: object[]) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', input: { tasks } }] });

describe('MeetingTaskExtractionService.extract', () => {
  it('ответ оборван по max_tokens — понятная ошибка, а не падение на undefined', async () => {
    const { service } = make([{ stop_reason: 'max_tokens', content: [{ type: 'tool_use', input: {} }] }]);
    await expect(service.extract(input())).rejects.toThrow('Встреча слишком длинная');
  });

  it('нет списка задач в ответе — ошибка', async () => {
    const { service } = make([{ stop_reason: 'tool_use', content: [{ type: 'tool_use', input: {} }] }]);
    await expect(service.extract(input())).rejects.toThrow('не вернул структурированный список задач');
  });

  it('расшифровка уходит модели с номерами реплик, дата встречи — местная', async () => {
    const { service, create } = make([toolResponse([])]);
    await service.extract(input());
    const params = create.mock.calls[0][0] as { model: string; system: string; messages: { content: string }[] };
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.system).toContain('дата: 2026-11-02');
    expect(params.system).toContain('Его собственные обещания');
    expect(params.messages[0].content).toContain('[S2] 01:15 Жандос Ахметов: Сделаю.');
  });

  it('сервер сопоставляет исполнителя, срок и реплику', async () => {
    const { service, resolve } = make([toolResponse([task()])]);
    const [p] = await service.extract(input());
    expect(resolve).toHaveBeenCalledWith('Жандос', EMPLOYEES);
    expect(p).toEqual({
      title: 'Подготовить смету',
      description: null,
      assigneeId: 'e1',
      assigneeRawText: 'Жандос',
      // Только день — 18:00 по Алматы.
      dueDate: new Date('2026-11-04T13:00:00Z'),
      priority: null,
      confidence: 'HIGH',
      sourceContext: 'Арман попросил подготовить смету к среде.',
      segmentId: 'seg-a',
      sourceTimestamp: '00:00',
    });
  });

  it('неоднозначное имя — без исполнителя, но с прозвучавшим именем; несуществующая реплика — без ссылки', async () => {
    const { service } = make([toolResponse([task({ ref: 'S99' })])], jest.fn().mockResolvedValue({ status: 'AMBIGUOUS', employeeId: null }));
    const [p] = await service.extract(input());
    expect(p).toMatchObject({ assigneeId: null, assigneeRawText: 'Жандос', segmentId: null, sourceTimestamp: null });
  });

  it('без расшифровки — один вызов по саммари', async () => {
    const { service, create } = make([toolResponse([task({ ref: null })])]);
    await service.extract(input({ transcript: [] }));
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as { system: string }).system).toContain('Расшифровки нет');
  });

  it('длинная расшифровка — по окнам, повтор на стыке окон не задваивается', async () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ segmentId: `seg-${i}`, startMs: i * 1000, speaker: 'Арман Ким', text: 'х'.repeat(3000) }));
    const { service, create } = make([toolResponse([task()]), toolResponse([task({ title: 'Подготовить смету.', ref: 'S16' }), task({ title: 'Согласовать договор', ref: 'S20' })]), toolResponse([])]);
    const result = await service.extract(input({ transcript: long }));
    expect(create).toHaveBeenCalledTimes(3);
    expect((create.mock.calls[1][0] as { system: string }).system).toContain('часть 2 из 3');
    expect(result.map((p) => p.title)).toEqual(['Подготовить смету', 'Согласовать договор']);
  });
});

describe('splitTranscript', () => {
  it('короткая — одно окно', () => {
    expect(splitTranscript(['a', 'b'])).toEqual(['a\nb']);
  });

  it('окна не длиннее предела, с перекрытием, строки не режутся', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(30, '.'));
    const windows = splitTranscript(lines, 100, 40);
    for (const w of windows) expect(w.length).toBeLessThanOrEqual(100);
    // Последняя строка окна повторяется в начале следующего.
    const first = windows[0].split('\n');
    expect(windows[1].startsWith(first[first.length - 1])).toBe(true);
    expect(windows[windows.length - 1].endsWith(lines[9])).toBe(true);
  });

  it('строка длиннее окна — отдельным окном, без зацикливания', () => {
    expect(splitTranscript(['x'.repeat(500), 'y'], 100, 40)).toEqual(['x'.repeat(500), 'y']);
  });
});

describe('parseLocalDue', () => {
  it('день — 18:00 по Алматы; время — как есть; мусор — null', () => {
    expect(parseLocalDue('2026-11-04')).toEqual(new Date('2026-11-04T13:00:00Z'));
    expect(parseLocalDue('2026-11-04T09:30')).toEqual(new Date('2026-11-04T04:30:00Z'));
    expect(parseLocalDue('в среду')).toBeNull();
    expect(parseLocalDue(null)).toBeNull();
  });
});

describe('formatTranscriptLine / mergeProposals', () => {
  it('строка реплики', () => {
    expect(formatTranscriptLine({ segmentId: 'x', startMs: 125_000, speaker: 'Speaker 2', text: 'Да.' }, 4)).toBe('[S5] 02:05 Speaker 2: Да.');
  });

  it('то же поручение другому исполнителю — не дубль', () => {
    const a = task() as never;
    const b = task({ assigneeRawText: 'Арман' }) as never;
    expect(mergeProposals([[a], [b]])).toHaveLength(2);
  });
});

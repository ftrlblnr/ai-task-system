import { buildRecoUserContent, normalizeTitle, parseRecommendations, recoFingerprint, recoTargetKey, RECO_MAX_ITEMS, RECO_SCHEMA, type RecoInput, type RecoTargets } from './recommendation-prompt';

const targets: RecoTargets = {
  skills: new Map([
    ['s1', { model: 'OPUS', enabled: true }],
    ['s2', { model: 'HAIKU', enabled: false }],
    ['tone', { model: 'HAIKU', enabled: true, service: true }],
  ]),
  routines: new Set(['r1']),
  memory: new Set(['m1']),
};

const base = {
  title: 'Сводка писем по утрам',
  benefit: 'Каждый день спрашивали про письма',
  plan: 'Регламент в 09:00 по будням',
  effort: 'LOW',
  priority: 1,
  tokenSaving: null,
  targetId: '',
  text: '',
  memoryKind: null,
  model: null,
  weeklyTokenCap: null,
  routine: null,
};

const routine = { title: 'Письма', prompt: 'Найди письма без ответа больше двух дней', days: [5, 1, 1, 9], time: '09:00', mode: 'PASSIVE', channel: 'TELEGRAM' };

function parse(items: unknown[], known = new Set<string>()) {
  return parseRecommendations(JSON.stringify({ recommendations: items }), targets, known);
}

describe('рекомендации: разбор ответа', () => {
  it('схема строгая: все поля обязательны, без лишних', () => {
    const item = RECO_SCHEMA.properties.recommendations.items;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
  });

  it('регламент: область, дни без повторов и вне 1..7', () => {
    const [r] = parse([{ ...base, action: 'CREATE_ROUTINE', routine }]);
    expect(r.area).toBe('ROUTINES');
    expect(r.payload.routine?.days).toEqual([1, 5]);
    expect(r.payload.targetId).toBeNull();
  });

  it('регламент без инструкции и без навыка — отбрасываем', () => {
    expect(parse([{ ...base, action: 'CREATE_ROUTINE', routine: { ...routine, prompt: '' } }])).toHaveLength(0);
    const [r] = parse([{ ...base, action: 'CREATE_ROUTINE', targetId: 's1', routine: { ...routine, prompt: '' } }]);
    expect(r.payload.targetId).toBe('s1');
  });

  it('цели только из данных', () => {
    expect(parse([{ ...base, action: 'DISABLE_SKILL', targetId: 'чужой' }])).toHaveLength(0);
    expect(parse([{ ...base, action: 'ARCHIVE_MEMORY', targetId: 'm2' }])).toHaveLength(0);
    expect(parse([{ ...base, action: 'ARCHIVE_MEMORY', targetId: 'm1' }])).toHaveLength(1);
  });

  it('навык в архиве не отключаем повторно, служебный /тон — никогда', () => {
    expect(parse([{ ...base, action: 'DISABLE_SKILL', targetId: 's2' }])).toHaveLength(0);
    expect(parse([{ ...base, action: 'DISABLE_SKILL', targetId: 'tone' }])).toHaveLength(0);
  });

  it('модель — только дешевле текущей', () => {
    expect(parse([{ ...base, action: 'DOWNGRADE_SKILL_MODEL', targetId: 's1', model: 'OPUS' }])).toHaveLength(0);
    const [r] = parse([{ ...base, action: 'DOWNGRADE_SKILL_MODEL', targetId: 's1', model: 'SONNET' }]);
    expect(r.payload.model).toBe('SONNET');
  });

  it('лимит регламента не меньше 1000', () => {
    expect(parse([{ ...base, action: 'SET_ROUTINE_CAP', targetId: 'r1', weeklyTokenCap: 500 }])).toHaveLength(0);
    expect(parse([{ ...base, action: 'SET_ROUTINE_CAP', targetId: 'r1', weeklyTokenCap: 50000 }])[0].payload.weeklyTokenCap).toBe(50000);
  });

  it('память и задача разработчику требуют текст', () => {
    expect(parse([{ ...base, action: 'ADD_MEMORY', text: 'Отчёты — по пятницам', memoryKind: null }])).toHaveLength(0);
    expect(parse([{ ...base, action: 'ADD_MEMORY', text: 'Отчёты — по пятницам', memoryKind: 'RULE' }])[0].area).toBe('MEMORY');
    expect(parse([{ ...base, action: 'DEV_TASK' }])).toHaveLength(0);
    expect(parse([{ ...base, action: 'DEV_TASK', text: 'Экран отчётов' }])[0].area).toBe('APPS');
  });

  it('отклонённое раньше не предлагаем снова, дубли в ответе — один раз', () => {
    const item = { ...base, action: 'CREATE_ROUTINE', routine };
    const known = new Set([recoFingerprint('CREATE_ROUTINE', null, 'Сводка  писем по утрам!')]);
    expect(parse([item], known)).toHaveLength(0);
    expect(parse([item, { ...item, title: 'СВОДКА писем по утрам' }])).toHaveLength(1);
  });

  it('то же действие над той же целью другими словами — не повторяем', () => {
    const item = { ...base, action: 'SET_ROUTINE_CAP', targetId: 'r1', weeklyTokenCap: 15000 };
    expect(parse([{ ...item, title: 'Поднять лимит до 40 000' }], new Set([recoTargetKey('SET_ROUTINE_CAP', 'r1')!]))).toHaveLength(0);
    expect(parse([item, { ...item, title: 'Другой заголовок' }])).toHaveLength(1);
    expect(parse([{ ...base, action: 'DISABLE_SKILL', targetId: 's1' }], new Set([recoTargetKey('SET_ROUTINE_CAP', 's1')!]))).toHaveLength(1);
  });

  it('не больше десяти, по приоритету', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ ...base, action: 'DEV_TASK', text: 'x', title: `Доработка ${i}`, priority: (i % 3) + 1 }));
    const out = parse(many);
    expect(out).toHaveLength(RECO_MAX_ITEMS);
    expect(out.map((r) => r.priority)).toEqual([...out.map((r) => r.priority)].sort());
  });

  it('не JSON — ошибка', () => {
    expect(() => parseRecommendations('нет', targets, new Set())).toThrow('не JSON');
  });

  it('заголовок нормализуется', () => {
    expect(normalizeTitle('Ёлки, палки!  ')).toBe('елки палки');
  });
});

describe('рекомендации: вход модели', () => {
  const input: RecoInput = {
    now: new Date('2026-10-30T04:00:00Z'),
    chat: [{ at: new Date('2026-10-28T05:00:00Z'), text: 'Что  с письмами\nот подрядчиков?' }],
    ai: [{ feature: 'assistant.reply', calls: 10, errors: 1, costUsd: 1.234, tokens: 5000 }],
    skills: [{ id: 's1', slug: 'отчёт', title: 'Отчёт', model: 'OPUS', enabled: true, shared: true, service: false, runs7d: 0, runs30d: 2, up: 0, down: 1, comments: ['длинно'] }],
    routines: [],
    memory: [{ id: 'm1', kind: 'RULE', text: 'Отчёт по пятницам', useCount: 0, lastUsedAt: null }],
    rejectedRevisions: [],
    dismissed: ['Сводка писем'],
    open: [],
    applied: ['Лимит регламента'],
  };

  it('собирает разделы с id и отклонёнными', () => {
    const text = buildRecoUserContent(input);
    expect(text).toContain('Сегодня 2026-10-30');
    expect(text).toContain('- 2026-10-28: Что с письмами от подрядчиков?');
    expect(text).toContain('assistant.reply: вызовов 10, ошибок 1, $1.23');
    expect(text).toContain('id=s1 /отчёт «Отчёт» модель OPUS (общий)');
    expect(text).toContain('замечания: «длинно»');
    expect(text).toContain('id=m1 [RULE] Отчёт по пятницам');
    expect(text).toMatch(/Отклонённые рекомендации[^\n]*\n- Сводка писем/);
    expect(text).toMatch(/Применённые за 30 дней[^\n]*\n- Лимит регламента/);
  });
});

import {
  buildLegalSystemPrompt,
  buildLegalTools,
  citationProblemsReport,
  formatLegalAnswer,
  parseSubmittedAnswer,
  verifyCitations,
  type ArticleLookup,
} from './legal-agent';

const DOCS = [
  { code: 'K2600000253', short: 'Строительный кодекс', title: 'Строительный кодекс РК' },
  { code: 'K990000409_', short: 'ГК (Особенная часть)', title: 'Гражданский кодекс РК (Особенная часть)' },
];

const ART_122: ArticleLookup = {
  text: 'Гарантийный срок … на несущие конструкции, кровлю и наружные стены (фасады) зданий – не менее десяти лет.',
  title: 'Гарантийный срок',
  short: 'Строительный кодекс',
  url: 'https://adilet.zan.kz/rus/docs/K2600000253',
};

describe('legal-agent: промпт и схемы', () => {
  it('промпт: позиция генподрядчика, только база, список актов', () => {
    const p = buildLegalSystemPrompt(DOCS);
    expect(p).toContain('только интересы генподрядчика');
    expect(p).toContain('Общие знания о праве');
    expect(p).toContain('K2600000253 — Строительный кодекс');
    expect(p).toContain('submit_answer');
  });

  it('инструменты: все strict, без лишних полей, код акта — закрытый enum', () => {
    const tools = buildLegalTools(DOCS);
    expect(tools.map((t) => t.name)).toEqual(['search_npa', 'get_article', 'verify_quote', 'term', 'submit_answer']);
    for (const t of tools) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.input_schema.required).toEqual(Object.keys(t.input_schema.properties as object));
    }
    const search = tools[0].input_schema.properties as Record<string, { enum?: string[] }>;
    expect(search.code.enum).toEqual(['', 'K2600000253', 'K990000409_']);
  });
});

describe('legal-agent: разбор и проверка ответа', () => {
  it('parseSubmittedAnswer: пустой вывод — null, мусор в массивах отбрасывается', () => {
    expect(parseSubmittedAnswer({ conclusion: '  ' })).toBeNull();
    expect(parseSubmittedAnswer(null)).toBeNull();
    const a = parseSubmittedAnswer({ conclusion: 'Да', reasoning: 1, citations: [null, { norm_id: 'X' }], not_covered: ['a', 2], questions: 'x' });
    expect(a).toEqual({ conclusion: 'Да', reasoning: '', citations: [{ norm_id: 'X', quote: '', relevance: '' }], not_covered: ['a'], questions: [] });
  });

  it('verifyCitations: подтверждает дословную цитату, ловит чужую статью и выдуманную цитату', () => {
    const articles = new Map<string, ArticleLookup | null>([
      ['K2600000253:ст.122', ART_122],
      ['K2600000253:ст.999', null],
    ]);
    const out = verifyCitations(
      [
        { norm_id: 'К2600000253: ст. 122', quote: 'наружные стены (фасады) зданий — не менее десяти лет', relevance: 'минимум' },
        { norm_id: 'K2600000253:ст.122', quote: 'не менее восьми лет', relevance: '' },
        { norm_id: 'K2600000253:ст.999', quote: 'что-то', relevance: '' },
        { norm_id: '', quote: 'без статьи', relevance: '' },
      ],
      articles,
    );
    expect(out.map((c) => c.verified)).toEqual([true, false, false, false]);
    expect(out[0]).toMatchObject({ normId: 'K2600000253:ст.122', articleTitle: 'Гарантийный срок', documentShort: 'Строительный кодекс' });
    expect(out[1].problems).toEqual(['цитата не найдена в тексте статьи']);
    expect(out[2].problems).toEqual(['статьи K2600000253:ст.999 нет в базе']);
    expect(out[3].problems).toEqual(['не указана статья']);

    const report = citationProblemsReport(out);
    expect(report).toContain('не подтвердила 3');
    expect(citationProblemsReport([out[0]])).toBeNull();
  });

  it('formatLegalAnswer: нормы с цитатами, пометка НЕ ПОДТВЕРЖДЕНО и дисклеймер', () => {
    const [ok, bad] = verifyCitations(
      [
        { norm_id: 'K2600000253:ст.122', quote: 'не менее десяти лет', relevance: 'минимум 10 лет' },
        { norm_id: 'K2600000253:ст.122', quote: 'не менее восьми лет', relevance: '' },
      ],
      new Map([['K2600000253:ст.122', ART_122]]),
    );
    const md = formatLegalAnswer({
      conclusion: 'Не меньше 10 лет.',
      reasoning: 'Императивная норма.',
      citations: [ok, bad],
      notCovered: ['Судебная практика'],
      questions: [],
      model: 'm',
    });
    expect(md).toContain('**Вывод.** Не меньше 10 лет.');
    expect(md).toContain('Строительный кодекс, «Гарантийный срок» — `K2600000253:ст.122`. минимум 10 лет');
    expect(md).toContain('> не менее десяти лет');
    expect(md).toContain('**НЕ ПОДТВЕРЖДЕНО:** цитата не найдена в тексте статьи');
    expect(md).toContain('- Судебная практика');
    expect(md).not.toContain('Уточните');
    expect(md.endsWith('_Проект. Требует проверки юристом._')).toBe(true);
  });
});

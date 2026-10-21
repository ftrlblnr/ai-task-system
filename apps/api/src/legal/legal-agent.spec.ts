import {
  buildLegalSystemPrompt,
  buildLegalTools,
  citationProblemsReport,
  findingProblemsReport,
  formatLegalAnswer,
  formatReviewSummary,
  asIsFoundInContract,
  parseSubmittedAnswer,
  parseSubmittedReview,
  riskCounts,
  sortFindings,
  verifyCitations,
  verifyFindings,
  type ArticleLookup,
  type LegalReview,
  type SubmittedFinding,
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

  describe('разбор договора', () => {
    const CONTRACT = 'п. 4.1. Гарантийный срок на выполненные работы составляет 8 (восемь) лет с даты подписания акта.\nп. 5.2. Ответственность Субподрядчика ограничивается суммой 1 000 000 тенге.';
    const finding = (over: Record<string, unknown> = {}): SubmittedFinding => ({
      clause: 'п. 4.1',
      as_is: 'Гарантийный срок на выполненные работы составляет 8 (восемь) лет',
      proposed: 'Гарантийный срок — 10 лет',
      reasoning: 'Императивный минимум.',
      gc_impact: 'ГП отвечает перед заказчиком 10 лет.',
      norm_id: 'K2600000253:ст.122',
      quote: 'не менее десяти лет',
      risk: 'высокий',
      type: 'несоответствие НПА',
      ...over,
    }) as SubmittedFinding;

    it('buildLegalTools(review): submit_review вместо submit_answer, схема строгая', () => {
      const tools = buildLegalTools(DOCS, 'review');
      const names = tools.map((t) => t.name);
      expect(names).toContain('submit_review');
      expect(names).not.toContain('submit_answer');
      const submit = tools.find((t) => t.name === 'submit_review')!;
      expect(submit.strict).toBe(true);
      expect(submit.input_schema.additionalProperties).toBe(false);
      expect(buildLegalSystemPrompt(DOCS, 'review')).toContain('<contract>');
    });

    it('parseSubmittedReview: без summary — null; неизвестные риск/тип — по умолчанию', () => {
      expect(parseSubmittedReview({ findings: [] })).toBeNull();
      expect(parseSubmittedReview(null)).toBeNull();
      const r = parseSubmittedReview({
        contract: ' Договор ',
        summary: 'Итог',
        findings: [finding({ risk: 'критический', type: 'прочее' }), 'мусор'],
        general_issues: ['a', '', 3],
      })!;
      expect(r.contract).toBe('Договор');
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0].risk).toBe('средний');
      expect(r.findings[0].type).toBe('коммерческий риск');
      expect(r.general_issues).toEqual(['a']);
      expect(r.not_checked).toEqual([]);
    });

    it('asIsFoundInContract: без учёта пробелов и кавычек, части через «…»', () => {
      const compactText = CONTRACT.replace(/\s+/g, '').toLowerCase();
      const c = (s: string) => asIsFoundInContract(s, compactText.replace(/ё/g, 'е'));
      expect(c('«Гарантийный  срок на выполненные работы составляет 8 (восемь) лет»')).toBe(true);
      expect(c('Гарантийный срок на выполненные работы … Ответственность Субподрядчика ограничивается')).toBe(true);
      expect(c('Гарантийный срок на работы составляет пять лет')).toBe(false);
      // Короткие фрагменты не проверяются — слишком легко совпасть или нет.
      expect(c('п. 4.1')).toBe(true);
    });

    it('verifyFindings: статья, цитата, «как есть»; норма необязательна', () => {
      const out = verifyFindings(
        [
          finding(),
          finding({ quote: 'не менее восьми лет' }),
          finding({ norm_id: 'K2600000253:ст.999' }),
          finding({ as_is: 'Гарантийный срок составляет пять лет с даты ввода', norm_id: '', quote: '' }),
          finding({ norm_id: '', quote: '', type: 'коммерческий риск' }),
        ],
        new Map([
          ['K2600000253:ст.122', ART_122],
          ['K2600000253:ст.999', null],
        ]),
        CONTRACT,
      );
      expect(out.map((f) => f.verified)).toEqual([true, false, false, false, true]);
      expect(out[0].documentShort).toBe('Строительный кодекс');
      expect(out[1].problems).toEqual(['цитата нормы не найдена в статье']);
      expect(out[2].problems[0]).toContain('нет в базе');
      expect(out[3].problems).toEqual(['фрагмент «как есть» не найден в договоре']);

      const report = findingProblemsReport(out);
      expect(report).toContain('не подтвердила 3 из 5');
      expect(report).toContain('находка 2 (п. 4.1)');
      expect(findingProblemsReport([out[0]])).toBeNull();
    });

    it('sortFindings/riskCounts/formatReviewSummary', () => {
      const findings = verifyFindings(
        [finding({ risk: 'низкий', clause: 'п. 7.3' }), finding(), finding({ risk: 'средний', clause: 'п. 5.2', quote: 'нет такой' })],
        new Map([['K2600000253:ст.122', ART_122]]),
        CONTRACT,
      );
      expect(sortFindings(findings).map((f) => f.risk)).toEqual(['высокий', 'средний', 'низкий']);
      expect(riskCounts(findings)).toEqual({ высокий: 1, средний: 1, низкий: 1 });

      const review: LegalReview = {
        contract: 'Договор субподряда',
        gcRole: 'генподрядчик — заказчик',
        applicableActs: 'ГК, Строительный кодекс',
        summary: 'Договор невыгоден ГП.',
        findings,
        generalIssues: [],
        notChecked: [],
        model: 'm',
      };
      const md = formatReviewSummary(review, 'Договор.docx');
      expect(md).toContain('**Разбор договора «Договор.docx» готов.** Находок: 3 (высокий риск — 1, средний — 1, низкий — 1).');
      expect(md).toContain('1. **п. 4.1** (высокий)');
      expect(md).toContain('**Не подтверждено проверкой по базе: 1**');
      expect(md).toContain('Проект. Требует проверки юристом.');
    });
  });
});

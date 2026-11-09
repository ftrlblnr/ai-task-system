import JSZip from 'jszip';
import { buildReviewDocx, reportFileName } from './legal-report';
import type { LegalReview, VerifiedFinding } from './legal-agent';

const base: Omit<VerifiedFinding, 'verified' | 'problems'> = {
  clause: 'п. 4.1',
  as_is: 'Гарантийный срок 8 лет',
  proposed: 'Гарантийный срок 10 лет',
  reasoning: 'Императивный минимум.',
  gc_impact: 'ГП отвечает перед заказчиком 10 лет.',
  norm_id: 'K2600000253:ст.122',
  quote: 'не менее десяти лет',
  risk: 'высокий',
  type: 'несоответствие НПА',
  articleTitle: 'Гарантийный срок',
  documentShort: 'Строительный кодекс',
};

const review: LegalReview = {
  contract: 'Договор субподряда № 15',
  gcRole: 'заказчик по договору субподряда',
  applicableActs: 'ГК, Строительный кодекс',
  summary: 'Договор смещён в пользу субподрядчика.',
  findings: [
    { ...base, risk: 'низкий', clause: 'п. 7.3', verified: true, problems: [] },
    { ...base, verified: false, problems: ['цитата нормы не найдена в статье'] },
  ],
  generalIssues: ['Нет порядка приёмки скрытых работ'],
  notChecked: ['Судебная практика'],
  model: 'claude-opus-5-5',
};

async function documentXml(buffer: Buffer): Promise<string> {
  return (await JSZip.loadAsync(buffer)).file('word/document.xml')!.async('string');
}

describe('legal-report', () => {
  it('buildReviewDocx: альбомная страница, сводка, находки по риску, пометка неподтверждённых', async () => {
    const buffer = await buildReviewDocx(review, { fileName: 'Договор.docx', documentsCount: 22, sourceDate: '2026-10-19', createdAt: new Date('2026-10-21T10:00:00Z') });
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    const xml = await documentXml(buffer);
    expect(xml).toContain('w:orient="landscape"');
    expect(xml).toContain('Проверка договора: Договор субподряда № 15');
    expect(xml).toContain('Проект. Требует проверки юристом.');
    expect(xml).toContain('выгрузка «Әділет» от 19.10.2026');
    expect(xml).toContain('Нет порядка приёмки скрытых работ');
    expect(xml).toContain('НЕ ПОДТВЕРЖДЕНО: цитата нормы не найдена в статье');
    expect(xml).toContain('Не удалось проверить по базе');
    // Высокий риск — первой строкой таблицы, хотя в разборе он второй.
    expect(xml.indexOf('п. 4.1')).toBeLessThan(xml.indexOf('п. 7.3'));
  });

  it('reportFileName: без расширения договора', () => {
    expect(reportFileName('Договор подряда.PDF')).toBe('Разбор — Договор подряда.docx');
    expect(reportFileName('.docx')).toBe('Разбор — договор.docx');
  });
});

describe('legal-report: финансы, переговоры, контрагент', () => {
  it('новые разделы: оценка, условия с цветом, план переговоров по приоритету, контрагент со ссылками для ручной проверки', async () => {
    const full: LegalReview = {
      ...review,
      financial: {
        verdict: 'невыгоден',
        verdict_reason: 'Оплата через 90 дней без аванса.',
        gc_pays: false,
        price: 'Твёрдая, 500 млн тг с НДС',
        cash_flow: 'ГП финансирует 3 месяца работ',
        liability_balance: 'Неустойка ГП без потолка, заказчика — 0,01%',
        terms: [{ topic: 'Аванс', clause: 'отсутствует', as_is: 'нет', assessment: 'отсутствует', practice: 'обычно 20–30%', proposed: 'Аванс 30%' }],
        money_risks: [{ risk: 'Неустойка ГП', calculation: '0,1% × 500 млн × 30 дн. = 15 млн тг', mitigation: 'Потолок 10%' }],
      },
      negotiation: [
        { priority: 'можно уступить', clause: 'п. 12', ask: 'Арбитраж в Алматы', fallback: '', argument: '' },
        { priority: 'обязательно', clause: 'п. 3', ask: 'Аванс 30%', fallback: 'Аванс 15%', argument: 'Закупка металла' },
      ],
      counterparty: {
        name: 'ТОО «Альфа»',
        bin: '040540001230',
        verdict: 'есть риски',
        facts: [
          { fact: 'Действующее ТОО', source: 'stat.gov.kz', url: 'https://stat.gov.kz/x', verified: true },
          { fact: 'Иск на 40 млн', source: 'новости', url: 'https://news.kz/y', verified: false },
        ],
        red_flags: ['Судебный спор с прошлым генподрядчиком'],
        not_verified: ['Налоговая задолженность — kgd.gov.kz недоступен'],
        binInContract: true,
        binChecksumOk: true,
      },
    };
    const xml = await documentXml(await buildReviewDocx(full, { fileName: 'Д.docx', documentsCount: 22, sourceDate: null, createdAt: new Date('2026-11-09T10:00:00Z') }));
    expect(xml).toContain('Финансовая оценка для генподрядчика');
    expect(xml).toContain('Итог: договор невыгоден.');
    expect(xml).toContain('0,1% × 500 млн × 30 дн. = 15 млн тг');
    expect(xml).toContain('Ориентир практики (оценка)');
    expect(xml).toContain('План переговоров');
    expect(xml.indexOf('Аванс 15%')).toBeLessThan(xml.indexOf('Арбитраж в Алматы'));
    expect(xml).toContain('Проверка контрагента');
    expect(xml).toContain('040540001230; есть в реквизитах договора; контрольная цифра верна');
    expect(xml).toContain('НЕ ПОДТВЕРЖДЕНО: адреса нет в результатах поиска');
    expect(xml).toContain('Проверить вручную');
    expect(xml).toContain('https://aisoip.adilet.gov.kz');
  });

  it('старый разбор без новых разделов собирается как раньше', async () => {
    const xml = await documentXml(await buildReviewDocx(review, { fileName: 'Д.docx', documentsCount: 1, sourceDate: null, createdAt: new Date() }));
    expect(xml).not.toContain('Финансовая оценка');
    expect(xml).not.toContain('Проверка контрагента');
  });
});

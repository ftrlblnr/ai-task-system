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

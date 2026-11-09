import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  manualCheckLinks,
  riskCounts,
  sortFindings,
  sortNegotiation,
  type CounterpartyCheck,
  type FinancialAssessment,
  type LegalReview,
  type NegotiationItem,
  type NegotiationPriority,
  type RiskLevel,
  type TermAssessment,
  type VerifiedFinding,
} from './legal-agent';

// Отчёт по разбору договора в Word (handoff, раздел 3.2) — порт вёрстки
// legal-agent/tools/build_review_docx.py: альбомная A4, сводка, общие
// проблемы, таблица находок с цветом риска, «Не удалось проверить по базе»,
// пометка «Проект. Требует проверки юристом».

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface ReportMeta {
  fileName: string;
  documentsCount: number;
  // Дата выгрузки «Әділет» (NpaDocument.sourceDate), YYYY-MM-DD.
  sourceDate: string | null;
  createdAt: Date;
}

const RISK_COLOR: Record<RiskLevel, string> = { высокий: 'F8CBAD', средний: 'FFF2CC', низкий: 'E2EFDA' };
const HEADER_FILL = '1F2A44';
const ASSESSMENT_COLOR: Record<TermAssessment, string> = { выгодно: 'E2EFDA', нейтрально: 'FFFFFF', невыгодно: 'F8CBAD', отсутствует: 'FFF2CC' };
const PRIORITY_COLOR: Record<NegotiationPriority, string> = { обязательно: 'F8CBAD', желательно: 'FFF2CC', 'можно уступить': 'E2EFDA' };
// Ширины таблиц новых разделов, см; итого те же 26,7 см.
const TERMS_CM = [3.2, 1.8, 6.0, 2.3, 5.4, 8.0];
const MONEY_CM = [7.5, 9.6, 9.6];
const NEGOTIATION_CM = [2.4, 2.0, 8.1, 7.1, 7.1];
const FACTS_CM = [12.7, 5.0, 9.0];
const UNVERIFIED_FILL = 'F8CBAD';
// Ширины колонок таблицы находок, см (как в эталоне); итого 26,7 см —
// ширина альбомной A4 за вычетом полей 1,5 см.
const COLUMNS_CM = [0.8, 2.0, 5.4, 5.4, 8.2, 2.6, 2.3];
const TWIPS_PER_CM = 567;
const FONT = 'Calibri';

function ruDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function text(value: string, opts: { bold?: boolean; italics?: boolean; color?: string; size?: number } = {}): TextRun {
  return new TextRun({ text: value, font: FONT, size: opts.size ?? 18, bold: opts.bold, italics: opts.italics, color: opts.color });
}

// Перевод строки внутри ячейки — отдельные абзацы (TextRun с \n Word не
// переносит).
function paragraphs(value: string, opts: { bold?: boolean; italics?: boolean; color?: string } = {}): Paragraph[] {
  return value.split('\n').map((line) => new Paragraph({ children: [text(line, opts)] }));
}

function cell(children: Paragraph[], widthCm: number, fill?: string): TableCell {
  return new TableCell({
    children: children.length ? children : [new Paragraph('')],
    width: { size: Math.round(widthCm * TWIPS_PER_CM), type: WidthType.DXA },
    shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
  });
}

function headerRow(titles: string[], widthsCm: number[]): TableRow {
  return new TableRow({
    tableHeader: true,
    children: titles.map((t, i) => cell([new Paragraph({ children: [text(t, { bold: true, color: 'FFFFFF' })] })], widthsCm[i], HEADER_FILL)),
  });
}

function bullet(value: string): Paragraph {
  return new Paragraph({ bullet: { level: 0 }, children: [text(value, { size: 20 })] });
}

function heading1(value: string, pageBreakBefore = false): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore, children: [text(value, { size: 28, bold: true })] });
}

function heading2(value: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200 }, children: [text(value, { size: 24, bold: true })] });
}

function labeled(label: string, value: string): Paragraph {
  return new Paragraph({ spacing: { after: 80 }, children: [text(`${label}: `, { bold: true, size: 20 }), text(value, { size: 20 })] });
}

function simpleTable(titles: string[], widthsCm: number[], rows: { cells: string[]; fills?: (string | undefined)[] }[]): Table {
  return new Table({
    columnWidths: widthsCm.map((w) => Math.round(w * TWIPS_PER_CM)),
    rows: [
      headerRow(titles, widthsCm),
      ...rows.map((r) => new TableRow({ children: r.cells.map((v, i) => cell(paragraphs(v || '—'), widthsCm[i], r.fills?.[i])) })),
    ],
  });
}

function financialSection(f: FinancialAssessment): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [heading1('Финансовая оценка для генподрядчика', true)];
  out.push(new Paragraph({ spacing: { after: 120 }, children: [text(`Итог: договор ${f.verdict}. `, { bold: true, size: 22 }), text(f.verdict_reason, { size: 20 })] }));
  if (f.gc_pays !== null) out.push(labeled('Деньги по договору', f.gc_pays ? 'генподрядчик платит' : 'генподрядчик получает'));
  if (f.price) out.push(labeled('Цена и модель', f.price));
  if (f.cash_flow) out.push(labeled('Кассовый разрыв', f.cash_flow));
  if (f.liability_balance) out.push(labeled('Баланс ответственности', f.liability_balance));
  if (f.terms.length) {
    out.push(heading2('Ключевые финансовые условия'));
    out.push(
      simpleTable(
        ['Условие', 'Пункт', 'Как в договоре', 'Оценка для ГП', 'Ориентир практики (оценка)', 'Предложение'],
        TERMS_CM,
        f.terms.map((t) => ({
          cells: [t.topic, t.clause, t.as_is, t.assessment, t.practice, t.proposed],
          fills: [undefined, undefined, undefined, ASSESSMENT_COLOR[t.assessment]],
        })),
      ),
    );
  }
  if (f.money_risks.length) {
    out.push(heading2('Денежные риски'));
    out.push(simpleTable(['Риск', 'Расчёт', 'Как снизить'], MONEY_CM, f.money_risks.map((r) => ({ cells: [r.risk, r.calculation, r.mitigation] }))));
  }
  return out;
}

function negotiationSection(items: NegotiationItem[]): (Paragraph | Table)[] {
  return [
    heading1('План переговоров'),
    new Paragraph({
      spacing: { after: 120 },
      children: [
        text('«Обязательно» — без этого подписывать опасно; «желательно» — заметно улучшает условия; «можно уступить» — разменная монета в торге.', {
          size: 20,
          italics: true,
        }),
      ],
    }),
    simpleTable(
      ['Приоритет', 'Пункт', 'Что просить', 'Запасная позиция', 'Аргумент'],
      NEGOTIATION_CM,
      sortNegotiation(items).map((n) => ({ cells: [n.priority, n.clause, n.ask, n.fallback, n.argument], fills: [PRIORITY_COLOR[n.priority]] })),
    ),
  ];
}

function counterpartySection(c: CounterpartyCheck): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [heading1('Проверка контрагента', true)];
  out.push(labeled('Контрагент', c.name || 'не указан'));
  const binNote = !c.bin
    ? 'в договоре не найден'
    : [
        c.bin,
        c.binInContract ? 'есть в реквизитах договора' : 'не найден в тексте договора',
        c.binChecksumOk ? 'контрольная цифра верна' : 'КОНТРОЛЬНАЯ ЦИФРА НЕ СХОДИТСЯ — сверьте реквизиты',
      ].join('; ');
  out.push(labeled('БИН/ИИН', binNote));
  out.push(new Paragraph({ spacing: { after: 120 }, children: [text(`Итог: ${c.verdict}.`, { bold: true, size: 22 })] }));
  if (c.red_flags.length) {
    out.push(heading2('Красные флаги'));
    out.push(...c.red_flags.map(bullet));
  }
  if (c.facts.length) {
    out.push(heading2('Найдено в открытых источниках'));
    out.push(
      simpleTable(
        ['Факт', 'Источник', 'Ссылка'],
        FACTS_CM,
        c.facts.map((f) => ({
          cells: [f.fact, f.source, f.verified ? f.url : `${f.url || '—'}\nНЕ ПОДТВЕРЖДЕНО: адреса нет в результатах поиска`],
          fills: [undefined, undefined, f.verified ? undefined : UNVERIFIED_FILL],
        })),
      ),
    );
  }
  if (c.not_verified.length) {
    out.push(heading2('Не удалось проверить'));
    out.push(...c.not_verified.map(bullet));
  }
  out.push(heading2('Проверить вручную'));
  out.push(...manualCheckLinks(c.bin).map((l) => bullet(`${l.title} — ${l.url}: ${l.what}`)));
  out.push(
    new Paragraph({
      spacing: { before: 120 },
      children: [
        text('Отсутствие сведений в найденных источниках не означает благонадёжности контрагента: часть госреестров РК доступна только вручную.', {
          italics: true,
          size: 18,
        }),
      ],
    }),
  );
  return out;
}

function findingRow(f: VerifiedFinding, n: number): TableRow {
  const reasoning = [f.gc_impact ? `Для генподрядчика: ${f.gc_impact}` : '', f.reasoning].filter(Boolean).join('\n');
  const basis = [...paragraphs(reasoning)];
  if (f.quote) basis.push(new Paragraph({ children: [text(`«${f.quote}»`, { italics: true })] }));
  const normTitle = [f.documentShort, f.articleTitle ? `«${f.articleTitle}»` : null].filter(Boolean).join(', ');
  const link = paragraphs(f.norm_id ? [f.norm_id, normTitle].filter(Boolean).join('\n') : '—');
  if (!f.verified) link.push(...paragraphs(`НЕ ПОДТВЕРЖДЕНО: ${f.problems.join('; ')}`, { bold: true }));
  return new TableRow({
    children: [
      cell(paragraphs(String(n)), COLUMNS_CM[0]),
      cell(paragraphs(f.clause || '—'), COLUMNS_CM[1]),
      cell(paragraphs(f.as_is), COLUMNS_CM[2]),
      cell(paragraphs(f.proposed), COLUMNS_CM[3]),
      cell(basis, COLUMNS_CM[4]),
      cell(link, COLUMNS_CM[5], f.verified ? undefined : UNVERIFIED_FILL),
      cell(paragraphs(`${f.risk}\n${f.type}`), COLUMNS_CM[6], RISK_COLOR[f.risk]),
    ],
  });
}

export function buildReviewDocument(review: LegalReview, meta: ReportMeta): Document {
  const findings = sortFindings(review.findings);
  const counts = riskCounts(findings);
  const nonCompliant = findings.filter((f) => f.type === 'несоответствие НПА').length;
  const unverified = findings.filter((f) => !f.verified).length;
  const base = `базе из ${meta.documentsCount} НПА РК${meta.sourceDate ? ` (выгрузка «Әділет» от ${ruDate(meta.sourceDate)})` : ''}`;

  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [text(`Проверка договора: ${review.contract}`, { size: 36, bold: true })] }),
    new Paragraph({
      children: [
        text('Проект. Требует проверки юристом. ', { bold: true, size: 20 }),
        text(
          `Проверка выполнена агентом-юристом по ${base} в интересах генподрядчика. Каждая ссылка на норму сверена с текстом статьи: дословность цитаты и наличие фрагмента «как есть» в договоре проверены программно. ID статьи: КОД:ст.N — код акта в «Әділет». Финансовые ориентиры — оценка агента, а не норма; сведения о контрагенте — из открытых источников со ссылками.`,
          { size: 20 },
        ),
      ],
    }),
    new Paragraph({
      children: [
        text(`Файл: ${meta.fileName}. Дата разбора: ${meta.createdAt.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' })}.`, { size: 20 }),
      ],
    }),
  ];
  if (review.gcRole) children.push(new Paragraph({ children: [text('Роль генподрядчика: ', { bold: true, size: 20 }), text(review.gcRole, { size: 20 })] }));
  if (review.applicableActs) {
    children.push(new Paragraph({ children: [text('Вид договора и применимые акты: ', { bold: true, size: 20 }), text(review.applicableActs, { size: 20 })] }));
  }

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [text('Сводка', { size: 28, bold: true })] }));
  const summaryWidths = [4.45, 4.45, 4.45, 4.45, 4.45, 4.45];
  children.push(
    new Table({
      rows: [
        headerRow(['Находок', 'Высокий риск', 'Средний риск', 'Низкий риск', 'Несоответствий НПА', 'Не подтверждено'], summaryWidths),
        new TableRow({
          children: [findings.length, counts['высокий'], counts['средний'], counts['низкий'], nonCompliant, unverified].map((v, i) =>
            cell([new Paragraph({ alignment: AlignmentType.CENTER, children: [text(String(v), { size: 20 })] })], summaryWidths[i]),
          ),
        }),
      ],
    }),
  );
  children.push(new Paragraph({ spacing: { before: 160 }, children: [text(review.summary, { size: 20 })] }));

  if (review.generalIssues.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [text('Общие проблемы', { size: 28, bold: true })] }));
    children.push(...review.generalIssues.map(bullet));
  }

  if (review.financial) children.push(...financialSection(review.financial));
  if (review.negotiation?.length) children.push(...negotiationSection(review.negotiation));
  if (review.counterparty) children.push(...counterpartySection(review.counterparty));

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [text('Находки', { size: 28, bold: true })] }));
  if (findings.length) {
    children.push(
      new Table({
        columnWidths: COLUMNS_CM.map((w) => Math.round(w * TWIPS_PER_CM)),
        rows: [
          headerRow(['№', 'Пункт', 'Как есть', 'Правка в пользу генподрядчика', 'Последствия для ГП, обоснование и цитата нормы', 'Ссылка', 'Риск / тип'], COLUMNS_CM),
          ...findings.map((f, i) => findingRow(f, i + 1)),
        ],
      }),
    );
  } else {
    children.push(new Paragraph({ children: [text('Существенных находок нет.', { size: 20 })] }));
  }

  children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [text('Не удалось проверить по базе', { size: 24, bold: true })] }));
  children.push(...(review.notChecked.length ? review.notChecked.map(bullet) : [new Paragraph({ children: [text('—', { size: 20 })] })]));

  return new Document({
    creator: 'Адъютант — агент-юрист',
    title: `Проверка договора: ${review.contract}`,
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 850, bottom: 850, left: 850, right: 850 },
          },
        },
        children,
      },
    ],
  });
}

export async function buildReviewDocx(review: LegalReview, meta: ReportMeta): Promise<Buffer> {
  return Packer.toBuffer(buildReviewDocument(review, meta));
}

// Имя файла отчёта: «Разбор — <имя договора без расширения>.docx».
export function reportFileName(contractFileName: string): string {
  const base = contractFileName.replace(/\.(pdf|docx)$/i, '').trim() || 'договор';
  return `Разбор — ${base}.docx`;
}

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
import { riskCounts, sortFindings, type LegalReview, type RiskLevel, type VerifiedFinding } from './legal-agent';

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
          `Проверка выполнена агентом-юристом по ${base} в интересах генподрядчика. Каждая ссылка на норму сверена с текстом статьи: дословность цитаты и наличие фрагмента «как есть» в договоре проверены программно. ID статьи: КОД:ст.N — код акта в «Әділет».`,
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

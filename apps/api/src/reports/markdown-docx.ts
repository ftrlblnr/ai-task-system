import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

// Общий отчёт в Word из markdown ответа модели (ARMS, фаза 3: навыки с
// output=DOCX, «artifact skills»). Модель пишет обычный markdown, вёрстка —
// здесь: заголовки, списки, жирный текст. Таблицы markdown не рисуем —
// строка таблицы становится абзацем через «·» (отчёты навыков их почти не
// используют, а битая таблица в Word хуже простого текста).

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const FONT = 'Calibri';
const BODY_SIZE = 22; // 11 pt
const MUTED = '6B7280';

// **жирный** внутри строки → чередование обычных и жирных фрагментов.
export function inlineRuns(line: string, base: { size?: number } = {}): TextRun[] {
  const size = base.size ?? BODY_SIZE;
  return line
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((chunk) =>
      chunk.startsWith('**') && chunk.endsWith('**')
        ? new TextRun({ text: chunk.slice(2, -2), bold: true, font: FONT, size })
        : new TextRun({ text: chunk.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2'), font: FONT, size }),
    );
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const;

export function markdownToParagraphs(markdown: string): Paragraph[] {
  const out: Paragraph[] = [];
  for (const raw of markdown.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) - 1;
      out.push(new Paragraph({ heading: HEADINGS[level], spacing: { before: 240, after: 80 }, children: inlineRuns(heading[2], { size: [32, 26, 23][level] }) }));
      continue;
    }
    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(new Paragraph({ bullet: { level: Math.min(Math.floor(bullet[1].length / 2), 2) }, children: inlineRuns(bullet[2]) }));
      continue;
    }
    const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(new Paragraph({ indent: { left: 360 + Math.floor(numbered[1].length / 2) * 360, hanging: 360 }, children: inlineRuns(`${numbered[2]}. ${numbered[3]}`) }));
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // разделитель шапки таблицы
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      out.push(new Paragraph({ children: inlineRuns(cells.join(' · ')) }));
      continue;
    }
    out.push(new Paragraph({ spacing: { after: 80 }, children: inlineRuns(line.trim()) }));
  }
  return out;
}

export async function buildMarkdownDocx(markdown: string, meta: { title: string; createdAt: Date }): Promise<Buffer> {
  const date = meta.createdAt.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' });
  const doc = new Document({
    creator: 'Адъютант',
    title: meta.title,
    styles: { default: { document: { run: { font: FONT, size: BODY_SIZE } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1418, right: 850 } } },
        children: [
          new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: `Адъютант · ${date}`, font: FONT, size: 18, color: MUTED })] }),
          ...markdownToParagraphs(markdown),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export function docxFileName(title: string, createdAt: Date): string {
  const day = createdAt.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' });
  return `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim()} ${day}.docx`;
}

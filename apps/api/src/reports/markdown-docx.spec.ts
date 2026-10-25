import { buildMarkdownDocx, docxFileName, markdownToParagraphs } from './markdown-docx';

describe('markdown → Word', () => {
  it('заголовки, списки, нумерация, таблица и пустые строки', () => {
    const md = '# Итоги\n\n## Главное\n- пункт **важный**\n  - вложенный\n1. первый\n| a | b |\n|---|---|\n| 1 | 2 |\n---\nабзац';
    // # , ##, 2 маркера, 1 нумерованный, 2 строки таблицы (разделитель пропущен), абзац
    expect(markdownToParagraphs(md)).toHaveLength(8);
  });

  it('документ — zip (docx)', async () => {
    const buf = await buildMarkdownDocx('# Итоги недели\n- готово', { title: 'Итоги недели', createdAt: new Date('2026-10-25T10:00:00Z') });
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });

  it('имя файла — без запрещённых символов, с датой', () => {
    expect(docxFileName('Итоги: неделя/октябрь', new Date('2026-10-25T10:00:00Z'))).toBe('Итоги  неделя октябрь 25.10.2026.docx');
  });
});

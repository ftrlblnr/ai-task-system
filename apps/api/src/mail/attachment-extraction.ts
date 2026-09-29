// Release 2 — извлечение текста из вложений-PDF (единственный поддерживаемый
// формат в этом релизе, решение владельца 28.09.2026; .docx/OCR — следующий
// заход). Изначально планировался пакет `pdf-parse`, но он вендорит древний
// pdf.js (последняя версия ветки 1.x — 2018 года) и не смог разобрать даже
// свежесгенерированный PDF (reportlab) — "bad XRef entry". Вместо него —
// `pdfjs-dist` напрямую (тот же движок Mozilla, актуальная версия, тоже
// чистый JS/WASM, без нативных зависимостей): пакет активно поддерживается и
// именно его использует pdf-parse@2.x под капотом.
//
// pdfjs-dist v6 собран как ESM (.mjs) — импортируется динамически из
// CommonJS-кода api (`module: nodenext` в tsconfig это поддерживает). Функции
// движка (Promise.withResolvers) требуют Node 22+ — production-контейнер
// (Dockerfile: node:22-alpine) и CI (actions/setup-node: 22) уже на этой
// версии, отдельный полифил не нужен.

export const MAX_EXTRACTION_INPUT_BYTES = 15 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_CHARS = 50_000;

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- динамический import ESM-пакета из CJS
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsPromise;
}

async function extractPdfText(buffer: Buffer): Promise<string | null> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    }
    const text = pages.join('\n').trim();
    return text || null;
  } finally {
    // pdfjs-dist@6's shipped .d.ts не объявляет PDFDocumentProxy.destroy()
    // (реальный метод есть в рантайме — освобождает воркер/буферы страниц),
    // отставание типов от кода — cast, не skipLibCheck (тот не покрывает
    // использование типа в НАШЕМ коде, только сами .d.ts).
    await (doc as unknown as { destroy(): Promise<void> }).destroy();
  }
}

// Лучшее из возможного: любая ошибка разбора (битый/зашифрованный/
// отсканированный без текстового слоя PDF) → null, никогда не блокирует синк
// письма — вызывающий код (MailSyncService) не различает "не PDF" и "PDF не
// разобрался", в обоих случаях extractedText просто остаётся null.
export async function extractAttachmentText(buffer: Buffer, mimeType: string | null | undefined): Promise<string | null> {
  if (mimeType !== 'application/pdf') return null;
  if (buffer.length === 0 || buffer.length > MAX_EXTRACTION_INPUT_BYTES) return null;
  try {
    const text = await extractPdfText(buffer);
    return text ? text.slice(0, MAX_EXTRACTED_TEXT_CHARS) : null;
  } catch {
    return null;
  }
}

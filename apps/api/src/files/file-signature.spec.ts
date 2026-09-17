import { isSuspiciousUpload, extensionMatchesMimeType, DOCX_MIME, XLSX_MIME } from './file-signature';

// Собирает минимальный валидный "stored" (без сжатия) ZIP с заданными
// именами записей — этого достаточно, чтобы протестировать
// listZipEntryNames/isValidOoxml без реальной библиотеки распаковки и без
// сгенерированного вручную настоящего .docx/.xlsx файла (Stage 2, Phase
// F.2, аудит 17.09.2026). Содержимое записей всегда пустое — парсер в
// file-signature.ts читает только central directory (имена), не данные.
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function buildStoredZip(entryNames: string[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const name of entryNames) {
    const nameBuf = Buffer.from(name, 'utf8');
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(0),
      u32(0),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);
    localParts.push(localHeader);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(0),
      u32(0),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entryNames.length),
    u16(entryNames.length),
    u32(centralSection.length),
    u32(localSection.length),
    u16(0),
  ]);

  return Buffer.concat([localSection, centralSection, eocd]);
}

// Stage 2, Phase F.1 (аудит 16.09.2026) — client.mimetype нельзя доверять
// как единственному подтверждению формата, magic bytes — второй, независимый
// от клиента источник истины.
describe('isSuspiciousUpload', () => {
  it('настоящий PDF с declared application/pdf — не подозрительный', () => {
    const buffer = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'application/pdf')).toBe(false);
  });

  it('настоящий PNG с declared image/png — не подозрительный', () => {
    const buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'image/png')).toBe(false);
  });

  it('PDF-подпись, но declared image/png — подозрительный (spoofed MIME)', () => {
    const buffer = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'image/png')).toBe(true);
  });

  it('исполняемый Windows PE ("MZ"), заявленный как text/plain — подозрительный', () => {
    const buffer = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'text/plain')).toBe(true);
  });

  it('исполняемый Linux ELF, заявленный как image/png — подозрительный', () => {
    const buffer = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'image/png')).toBe(true);
  });

  it('обычный текст с declared text/plain — не подозрительный (нет позитивной сигнатуры, но и не похож на бинарник)', () => {
    const buffer = Buffer.from('Привет, это обычный текстовый файл', 'utf8');
    expect(isSuspiciousUpload(buffer, 'text/plain')).toBe(false);
  });

  it('не-ZIP с declared xlsx — подозрительный', () => {
    const buffer = Buffer.alloc(20);
    expect(isSuspiciousUpload(buffer, XLSX_MIME)).toBe(true);
  });

  // Phase F.2 (аудит 17.09.2026) — раньше любой ZIP проходил как
  // docx/xlsx, теперь нужна структура OOXML ("[Content_Types].xml" +
  // word//xl/-запись), не просто "это ZIP".
  it('произвольный ZIP (не OOXML) с declared xlsx — подозрительный', () => {
    const buffer = buildStoredZip(['readme.txt', 'data.bin']);
    expect(isSuspiciousUpload(buffer, XLSX_MIME)).toBe(true);
  });

  it('валидная структура XLSX ("[Content_Types].xml" + "xl/workbook.xml") — не подозрительный', () => {
    const buffer = buildStoredZip(['[Content_Types].xml', 'xl/workbook.xml', '_rels/.rels']);
    expect(isSuspiciousUpload(buffer, XLSX_MIME)).toBe(false);
  });

  it('валидная структура DOCX ("[Content_Types].xml" + "word/document.xml") — не подозрительный', () => {
    const buffer = buildStoredZip(['[Content_Types].xml', 'word/document.xml']);
    expect(isSuspiciousUpload(buffer, DOCX_MIME)).toBe(false);
  });

  it('ZIP с "[Content_Types].xml", но без "xl/"-записи, заявленный как xlsx — подозрительный (структура DOCX под именем XLSX)', () => {
    const buffer = buildStoredZip(['[Content_Types].xml', 'word/document.xml']);
    expect(isSuspiciousUpload(buffer, XLSX_MIME)).toBe(true);
  });
});

describe('extensionMatchesMimeType (Stage 2, Phase F.2 — расширение файла должно соответствовать заявленному MIME)', () => {
  it('совпадающее расширение/MIME — true', () => {
    expect(extensionMatchesMimeType('отчёт.pdf', 'application/pdf')).toBe(true);
    expect(extensionMatchesMimeType('report.PDF', 'application/pdf')).toBe(true);
    expect(extensionMatchesMimeType('photo.jpeg', 'image/jpeg')).toBe(true);
    expect(extensionMatchesMimeType('photo.jpg', 'image/jpeg')).toBe(true);
  });

  it('расширение не соответствует заявленному MIME — false (например .exe с application/pdf)', () => {
    expect(extensionMatchesMimeType('wow.exe', 'application/pdf')).toBe(false);
  });

  it('незнакомый MIME (нет в FORMAT_RULES) — false', () => {
    expect(extensionMatchesMimeType('file.bin', 'application/octet-stream')).toBe(false);
  });
});

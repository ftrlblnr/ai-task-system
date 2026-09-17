// Phase F.1 (аудит 16.09.2026) — file.mimetype в multipart-запросе
// заявляет клиент, это не подтверждение реального формата: файл может
// назвать себя image/png, а внутри быть чем угодно. Библиотека вроде
// file-type здесь избыточна — allowlist фиксированный и небольшой
// (apps/api/src/files/dto/upload-file.dto.ts), несколько магических
// байт проверяются вручную.
//
// Phase F.2 (аудит 17.09.2026) — раньше DOCX/XLSX проверялись только как
// "это ZIP" (PK...), чего недостаточно: произвольный .zip, переименованный
// в .docx, проходил бы эту проверку. Теперь для них дополнительно читается
// central directory ZIP (без внешней библиотеки — сами данные не
// распаковываются, только имена записей) и проверяется структура OOXML:
// обязательный "[Content_Types].xml" плюс "word/"-запись (DOCX) или
// "xl/"-запись (XLSX). Это структурная проверка контейнера, не валидация
// содержимого документа — файл всё ещё может быть "мусорным" валидным
// OOXML, просто это уже не любой произвольный ZIP под чужим расширением.
//
// TXT/CSV — обычный текст без надёжной сигнатуры: вместо позитивной
// проверки отклоняем, если байты похожи на исполняемый файл под видом
// текста (PE/ELF-заголовок) или неожиданно являются ZIP.
//
// FORMAT_RULES — одна таблица на оба типа проверок (P0.2): и "байты
// соответствуют заявленному MIME" (isSuspiciousUpload), и "расширение
// файла соответствует заявленному MIME" (extensionMatchesMimeType) — не
// две параллельные структуры данных, которые могут разойтись.

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function hasPrefix(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((b, i) => buffer[i] === b);
}

function isZip(buffer: Buffer): boolean {
  return hasPrefix(buffer, [0x50, 0x4b, 0x03, 0x04]);
}

function looksExecutable(buffer: Buffer): boolean {
  const isWindowsPE = buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a; // "MZ"
  const isLinuxElf = hasPrefix(buffer, [0x7f, 0x45, 0x4c, 0x46]); // "\x7fELF"
  return isWindowsPE || isLinuxElf;
}

function isPdf(b: Buffer): boolean {
  return b.subarray(0, 4).toString('latin1') === '%PDF';
}

function isPng(b: Buffer): boolean {
  return hasPrefix(b, [0x89, 0x50, 0x4e, 0x47]);
}

function isJpeg(b: Buffer): boolean {
  return hasPrefix(b, [0xff, 0xd8, 0xff]);
}

function isGif(b: Buffer): boolean {
  return b.subarray(0, 4).toString('latin1') === 'GIF8';
}

function isWebp(b: Buffer): boolean {
  return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
}

function isSoftTextFormat(b: Buffer): boolean {
  return !looksExecutable(b) && !isZip(b);
}

const EOCD_SIGNATURE = 0x06054b50; // "PK\x05\x06", little-endian как 32-битное число
const CENTRAL_DIR_SIGNATURE = 0x02014b50; // "PK\x01\x02"
const EOCD_FIXED_SIZE = 22;
const CENTRAL_DIR_ENTRY_FIXED_SIZE = 46;
const MAX_ZIP_COMMENT_SIZE = 65535; // максимум по спецификации ZIP (2 байта на длину)

// Читает только central directory ZIP (имена записей), не распаковывает
// содержимое — этого достаточно, чтобы отличить настоящий DOCX/XLSX от
// произвольного ZIP под тем же расширением, без библиотеки для
// распаковки. Возвращает null для повреждённого/укороченного/не-ZIP файла
// — вызывающий код трактует null как "невалидно", а не бросает исключение.
function listZipEntryNames(buffer: Buffer): string[] | null {
  if (!isZip(buffer)) return null;

  const searchStart = Math.max(0, buffer.length - EOCD_FIXED_SIZE - MAX_ZIP_COMMENT_SIZE);
  let eocdOffset = -1;
  for (let i = buffer.length - EOCD_FIXED_SIZE; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);

  const names: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + CENTRAL_DIR_ENTRY_FIXED_SIZE > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      return null;
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + CENTRAL_DIR_ENTRY_FIXED_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) return null;
    names.push(buffer.subarray(nameStart, nameEnd).toString('utf8'));
    offset = nameEnd + extraLength + commentLength;
  }
  return names;
}

function isValidOoxml(buffer: Buffer, requiredEntryPrefix: string): boolean {
  const names = listZipEntryNames(buffer);
  if (!names) return false;
  return names.includes('[Content_Types].xml') && names.some((n) => n.startsWith(requiredEntryPrefix));
}

function isValidDocx(buffer: Buffer): boolean {
  return isValidOoxml(buffer, 'word/');
}

function isValidXlsx(buffer: Buffer): boolean {
  return isValidOoxml(buffer, 'xl/');
}

export interface FormatRule {
  extensions: string[];
  mimeType: string;
  isValidContent: (buffer: Buffer) => boolean;
}

export const FORMAT_RULES: FormatRule[] = [
  { extensions: ['.pdf'], mimeType: 'application/pdf', isValidContent: isPdf },
  { extensions: ['.png'], mimeType: 'image/png', isValidContent: isPng },
  { extensions: ['.jpg', '.jpeg'], mimeType: 'image/jpeg', isValidContent: isJpeg },
  { extensions: ['.gif'], mimeType: 'image/gif', isValidContent: isGif },
  { extensions: ['.webp'], mimeType: 'image/webp', isValidContent: isWebp },
  { extensions: ['.docx'], mimeType: DOCX_MIME, isValidContent: isValidDocx },
  { extensions: ['.xlsx'], mimeType: XLSX_MIME, isValidContent: isValidXlsx },
  { extensions: ['.csv'], mimeType: 'text/csv', isValidContent: isSoftTextFormat },
  { extensions: ['.txt'], mimeType: 'text/plain', isValidContent: isSoftTextFormat },
];

function ruleForMimeType(mimeType: string): FormatRule | undefined {
  return FORMAT_RULES.find((r) => r.mimeType === mimeType);
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

// true = отклонить загрузку. Исполняемый файл под любым заявленным типом —
// всегда отклоняется. Для типов без правила в FORMAT_RULES проверяется
// только "не похоже на исполняемый", дальше доверяем.
export function isSuspiciousUpload(buffer: Buffer, declaredMimeType: string): boolean {
  if (looksExecutable(buffer)) return true;
  const rule = ruleForMimeType(declaredMimeType);
  if (!rule) return false;
  return !rule.isValidContent(buffer);
}

// P0.2 (аудит 17.09.2026) — имя файла должно соответствовать заявленному
// MIME, а не быть независимым, никак не проверяемым полем (иначе
// "отчёт.exe" с MIME application/pdf прошёл бы мимо этой проверки).
// Незнакомый MIME (нет в FORMAT_RULES) — уже отклонён раньше, на уровне
// ALLOWED_UPLOAD_MIME_TYPES/fileFilter, сюда такой вызов дойти не должен.
export function extensionMatchesMimeType(name: string, mimeType: string): boolean {
  const rule = ruleForMimeType(mimeType);
  if (!rule) return false;
  return rule.extensions.includes(fileExtension(name));
}

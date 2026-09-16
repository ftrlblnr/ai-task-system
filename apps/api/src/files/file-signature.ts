// Phase F.1 (аудит 16.09.2026) — file.mimetype в multipart-запросе
// заявляет клиент, это не подтверждение реального формата: файл может
// назвать себя image/png, а внутри быть чем угодно. Библиотека вроде
// file-type здесь избыточна — allowlist фиксированный и небольшой
// (apps/api/src/files/dto/upload-file.dto.ts), несколько магических
// байт проверяются вручную.
//
// DOCX/XLSX — оба ZIP-контейнеры; полноценная проверка OOXML-структуры
// внутри ZIP (что это именно Word/Excel, а не произвольный .zip,
// переименованный в .docx) намного тяжелее для этого шага и не
// покрывается спекой как обязательное требование — здесь сознательно
// только "это действительно ZIP", не глубже. Ограничение зафиксировано,
// не спрятано.
//
// TXT/CSV — обычный текст без надёжной сигнатуры: вместо позитивной
// проверки отклоняем, если байты похожи на исполняемый файл под видом
// текста (PE/ELF-заголовок) или неожиданно являются ZIP.

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

const SIGNATURE_CHECKS: Record<string, (buffer: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 4).toString('latin1') === '%PDF',
  'image/png': (b) => hasPrefix(b, [0x89, 0x50, 0x4e, 0x47]),
  'image/jpeg': (b) => hasPrefix(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': isZip,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': isZip,
};

// true = отклонить загрузку. Исполняемый файл под любым заявленным типом —
// всегда отклоняется. Для типов без сигнатуры в SIGNATURE_CHECKS (TXT/CSV)
// проверяется только "не похоже на исполняемый", дальше доверяем — как и
// описано в спеке, правила для текстовых форматов мягче.
export function isSuspiciousUpload(buffer: Buffer, declaredMimeType: string): boolean {
  if (looksExecutable(buffer)) return true;
  const check = SIGNATURE_CHECKS[declaredMimeType];
  if (!check) return false;
  return !check(buffer);
}

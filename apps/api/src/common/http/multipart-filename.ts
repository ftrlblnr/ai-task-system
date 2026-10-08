// Busboy/Multer декодируют имя файла из multipart-заголовка как latin1
// (исторический дефолт HTTP multipart, RFC 7578 не требует UTF-8) — не-
// ASCII имя (кириллица — обычный случай в этом проекте) приходит в
// originalname искажённым (каждый UTF-8 байт интерпретирован как отдельный
// latin1-символ). Обратное перекодирование latin1→utf8 — стандартный
// обходной путь для этого известного поведения Busboy, а не специфика
// этого проекта (найдено 16.09.2026 живым тестом с реальным кириллическим
// именем файла — "Отчёт.txt" превращалось в мусор без этой строки).
// Вынесено из files.controller.ts (Stage 2, Phase F) — тот же фикс нужен
// везде, где принимается multipart-загрузка (trips.controller.ts, Агент
// поездок, ТЗ 08.10.2026).
export function fixMultipartFileName(originalName: string): string {
  return Buffer.from(originalName, 'latin1').toString('utf8');
}

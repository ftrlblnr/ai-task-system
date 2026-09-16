// Не class-validator DTO (multipart-запрос, тело — сам файл, не JSON) —
// просто константы allowlist/лимита, тот же дух, что ALLOWED_MIME_TYPES в
// voice.controller.ts, только вынесено в отдельный файл, потому что этими
// же константами пользуется и FilesService (fileFilter в контроллере и
// сама проверка при сохранении — на случай, если что-то обратится в обход
// FileInterceptor).

// Спека Stage 2 §9 — конкретный список типов для MVP вложений, не
// «всё, что не exe»: осознанный allowlist, не denylist.
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'text/csv',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

// 20MB — тот же порядок величины, что уже есть в проекте (25MB — жёсткий
// лимит самого Whisper API для голосовых заметок, apps/api/src/voice/
// voice.controller.ts) — не выдумываю новое число без причины.
export const MAX_UPLOAD_FILE_SIZE = 20 * 1024 * 1024;

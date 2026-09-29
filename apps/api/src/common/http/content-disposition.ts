// Вынесено из files.controller.ts (Release 2 — mail.controller.ts тоже
// отдаёт файл на скачивание, дублировать функцию не стоит). Content-
// Disposition с не-ASCII именем (кириллица — обычный случай в этом
// проекте) — classic filename="" ломается на не-ASCII, RFC 5987
// filename*=UTF-8''... рядом с ASCII-фолбэком — то же самое расширение,
// каким уже сегодня пользуются браузеры/curl.
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

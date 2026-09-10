// Сервер (Docker-контейнер) всегда работает в UTC, а компания — в
// Казахстане (Asia/Almaty, UTC+5, без перехода на летнее время —
// фиксированное смещение, без нужды в полноценной библиотеке часовых
// поясов). Раньше это жило только в draft-extraction.service.ts и было
// продублировано в DailyDigestCron (сравнение дат в UTC вместо +5 — найдено
// в аудите 10.09.2026, п. 2.7: срок "завтра 02:00 по Алматы" считался
// сроком "сегодня", т.к. в UTC это 21:00 предыдущего дня). Единственный
// источник правды по смещению — здесь.
export const TIMEZONE_OFFSET_HOURS = 5;
export const TIMEZONE_OFFSET_STRING = '+05:00';

export function nowInLocalTimezone(): string {
  const localMs = Date.now() + TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
  return new Date(localMs).toISOString().replace('Z', '');
}

// Даты из БД (Date, реальный UTC-момент) — честный пересчёт в местное
// время с явным смещением на конце, не "как есть".
export function formatLocalDateTime(date: Date): string {
  const localMs = date.getTime() + TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
  return new Date(localMs).toISOString().replace('Z', TIMEZONE_OFFSET_STRING);
}

// Календарная дата (YYYY-MM-DD) по местному времени — для сравнения "это
// сегодня?" без риска съехать на UTC-полночь (см. DailyDigestCron).
export function localDateString(date: Date): string {
  const localMs = date.getTime() + TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
  return new Date(localMs).toISOString().slice(0, 10);
}

// Приводит дату/время, которые вернула модель, к однозначной ISO-строке со
// смещением +05:00 — не полагаемся на то, что Claude сама допишет
// правильное смещение (или не допишет вовсе Z по ошибке): обрезаем любой
// уже присутствующий суффикс и подставляем свой.
export function withLocalOffset(value: string | null): string | null {
  if (!value) return value;
  const bare = value.replace(/(Z|[+-]\d{2}:?\d{2})$/, '');
  return `${bare}${TIMEZONE_OFFSET_STRING}`;
}

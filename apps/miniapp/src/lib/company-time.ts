// Время компании — Казахстан (Asia/Almaty, UTC+5), как common/timezone.ts на
// сервере. «Сегодня», сроки и время встреч считаем по нему, а не по часам
// устройства: руководитель в поездке видит тот же день, что и сервер.
const TIME_ZONE = 'Asia/Almaty';

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: TIME_ZONE, day: 'numeric', month: 'short' });
const kickerFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' });

// YYYY-MM-DD — для сравнения «это сегодня?».
export function companyDayKey(date: Date | string): string {
  return dayKeyFormat.format(new Date(date));
}

export function companyTime(date: Date | string): string {
  return timeFormat.format(new Date(date));
}

export function companyDate(date: Date | string): string {
  return dateFormat.format(new Date(date));
}

// «пятница, 24 октября» — надзаголовок «Сегодня».
export function companyKicker(date: Date): string {
  return kickerFormat.format(date);
}

// «через 25 мин», «через 2 ч 10 мин».
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

// Арифметика дней по ключу YYYY-MM-DD (календарь, M3): сам ключ — дата
// компании, поэтому считаем в UTC без участия часового пояса устройства.
function keyToUtc(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(key: string, days: number): string {
  return new Date(keyToUtc(key) + days * 86_400_000).toISOString().slice(0, 10);
}

// 0 — понедельник … 6 — воскресенье.
export function weekdayIndex(key: string): number {
  return (new Date(keyToUtc(key)).getUTCDay() + 6) % 7;
}

export function weekStartKey(key: string): string {
  return addDays(key, -weekdayIndex(key));
}

export function dayOfMonth(key: string): number {
  return Number(key.slice(8, 10));
}

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

// Смещение пояса компании от UTC в момент at — через Intl, а не константой
// +5: правила пояса меняются (Казахстан перешёл с +6 на +5 в 2024).
function zoneOffsetMs(at: number): number {
  const p = Object.fromEntries(partsFormat.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at / 1000) * 1000;
}

// Полночь дня компании как момент времени.
export function companyDayStart(key: string): Date {
  const utc = keyToUtc(key);
  return new Date(utc - zoneOffsetMs(utc));
}

// Минуты от полуночи дня компании (может быть <0 или >1440 для соседних дней).
export function minutesFromDayStart(date: Date | string, key: string): number {
  return (new Date(date).getTime() - companyDayStart(key).getTime()) / 60_000;
}

const monthFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', month: 'long', year: 'numeric' });

// «Октябрь 2026» — надзаголовок календаря.
export function monthLabel(key: string): string {
  const s = monthFormat.format(new Date(keyToUtc(key))).replace(/\s*г\.$/, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

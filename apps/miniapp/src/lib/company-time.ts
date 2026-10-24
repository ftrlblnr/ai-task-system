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

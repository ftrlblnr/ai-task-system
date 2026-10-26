// Время и сроки на пульте — по календарю компании (Asia/Almaty).
export const TZ = 'Asia/Almaty';

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

export function dayTime(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now).toLocaleDateString('ru-RU', { timeZone: TZ });
  const day = d.toLocaleDateString('ru-RU', { timeZone: TZ });
  return day === today ? time(iso) : `${d.toLocaleDateString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit' })} ${time(iso)}`;
}

// «40 мин», «3 ч», «2 дн» — сколько прошло (или осталось) от и до.
export function span(fromMs: number, toMs: number): string {
  const minutes = Math.max(0, Math.round((toMs - fromMs) / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  return `${Math.round(hours / 24)} дн`;
}

export function usd(value: number): string {
  if (value === 0) return '$0';
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
}

export function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1000)} тыс.`;
  return `${(value / 1_000_000).toFixed(1)} млн`;
}

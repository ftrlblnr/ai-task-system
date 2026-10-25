import { TIMEZONE_OFFSET_HOURS } from '../common/timezone';

// Расписание регламента (ARMS, фаза 4): cron из 5 полей «мин час день мес
// день-недели» в местном времени (Алматы, фиксированные UTC+5 — см.
// common/timezone.ts). Свой разбор, а не библиотека: нужен только расчёт
// следующего запуска, а форма в вебе собирает простой вид «дни недели +
// время». День недели — 0..7, 0 и 7 = воскресенье (как в обычном cron).

const OFFSET_MS = TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Дальше года вперёд не ищем: такое расписание (31 февраля) считаем пустым.
const SEARCH_DAYS = 366;

interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function parseField(raw: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) return null;
    let from = min;
    let to = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      from = a;
      to = b ?? (m[2] ? max : a);
    }
    if (from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const dow = parseField(parts[4], 0, 7);
  if (!minutes || !hours || !dom || !months || !dow) return null;
  return {
    minutes,
    hours,
    daysOfMonth: new Set(dom),
    months: new Set(months),
    daysOfWeek: new Set(dow.map((d) => d % 7)),
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

// Как в cron: если ограничены и день месяца, и день недели — подходит любой.
function dayMatches(f: CronFields, local: Date): boolean {
  if (!f.months.has(local.getUTCMonth() + 1)) return false;
  const dom = f.daysOfMonth.has(local.getUTCDate());
  const dow = f.daysOfWeek.has(local.getUTCDay());
  if (f.domAny && f.dowAny) return true;
  if (f.domAny) return dow;
  if (f.dowAny) return dom;
  return dom || dow;
}

// Первый момент строго после `after`. Работаем в «местных» Date (UTC-поля =
// время Алматы), на выходе — настоящий UTC.
export function nextRunAfter(expr: string, after: Date): Date | null {
  const f = parseCron(expr);
  if (!f) return null;
  const localAfter = after.getTime() + OFFSET_MS;
  const dayStart = Math.floor(localAfter / DAY_MS) * DAY_MS;
  for (let d = 0; d <= SEARCH_DAYS; d++) {
    const day = new Date(dayStart + d * DAY_MS);
    if (!dayMatches(f, day)) continue;
    for (const h of f.hours) {
      for (const m of f.minutes) {
        const local = day.getTime() + (h * 60 + m) * 60 * 1000;
        if (local > localAfter) return new Date(local - OFFSET_MS);
      }
    }
  }
  return null;
}

// Простой вид для формы: дни недели 1..7 (Пн..Вс) и время «ЧЧ:ММ».
export interface SimpleSchedule {
  days: number[];
  time: string;
}

export function buildSimpleCron(s: SimpleSchedule): string | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.time);
  const days = [...new Set(s.days)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!m || days.length === 0) return null;
  const dow = days.length === 7 ? '*' : days.map((d) => d % 7).join(',');
  return `${Number(m[2])} ${Number(m[1])} * * ${dow}`;
}

// Обратно — только для расписаний простого вида; иное показываем как cron.
export function parseSimpleCron(expr: string | null): SimpleSchedule | null {
  if (!expr) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || parts[2] !== '*' || parts[3] !== '*') return null;
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  const f = parseCron(expr);
  if (!f) return null;
  const days = [...f.daysOfWeek].map((d) => (d === 0 ? 7 : d)).sort((a, b) => a - b);
  return { days, time: `${String(f.hours[0]).padStart(2, '0')}:${String(f.minutes[0]).padStart(2, '0')}` };
}

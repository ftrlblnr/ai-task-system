// Программа поездки во времени (владелец 23.10.2026): часть поездки в
// Казахстане, часть в Пекине — время каждого пункта показывается по месту
// проведения (не по часовому поясу телефона), а при открытии программы видно,
// где руководитель должна быть сейчас и что дальше. Чистые функции — общие для
// web и Mini App.

export const DEFAULT_TRIP_OFFSET_MINUTES = 300; // Казахстан, UTC+5

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Событие без окончания длится до следующего пункта, но не дольше этого.
const MAX_OPEN_EVENT_MS = 3 * HOUR;
const DEFAULT_EVENT_MS = HOUR;
const DEFAULT_LEG_MS = 2 * HOUR;
// «Сейчас» показывается, пока до начала программы или после её конца не больше суток.
const TRIP_EDGE_MS = 24 * HOUR;

export type TimelineKind = 'leg' | 'event' | 'stay';

interface LegLike {
  id: string;
  departAt: string | null;
  departTimeZoneOffsetMinutes: number | null;
  arriveAt: string | null;
  arriveTimeZoneOffsetMinutes: number | null;
}
interface EventLike {
  id: string;
  startAt: string | null;
  startTimeZoneOffsetMinutes: number | null;
  dateOnly: string | null;
  endAt: string | null;
}
interface StayLike {
  id: string;
  checkInAt: string | null;
  checkOutAt: string | null;
}

export interface TripLike<L extends LegLike = LegLike, E extends EventLike = EventLike, S extends StayLike = StayLike> {
  legs: L[];
  events: E[];
  stays: S[];
}

export interface TimelineEntry<L = LegLike, E = EventLike, S = StayLike> {
  key: string;
  kind: TimelineKind;
  item: L | E | S;
  // Начало/конец (мс UTC). Нет начала — пункт без подтверждённого времени.
  start: number | null;
  end: number | null;
  // Пояс места, где проходит пункт (минуты от UTC); у перелёта — пояс вылета.
  offset: number;
  // Пояс прилёта (только у перелёта/переезда).
  arriveOffset?: number;
  // Известна только дата (YYYY-MM-DD) — без часа.
  dateOnly: string | null;
}

function ms(value: string | null): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

// Точки «в этот момент руководитель в таком поясе»: явные пояса событий и
// перелётов. Для пункта без своего пояса (проживание, событие без пояса) берётся
// пояс последней точки до него, иначе ближайшей после, иначе Казахстан.
function zoneResolver(points: { at: number; offset: number }[]): (at: number | null) => number {
  const sorted = [...points].sort((a, b) => a.at - b.at);
  return (at) => {
    if (sorted.length === 0) return DEFAULT_TRIP_OFFSET_MINUTES;
    if (at === null) return sorted[0].offset;
    let found: number | null = null;
    for (const p of sorted) {
      if (p.at <= at) found = p.offset;
      else break;
    }
    return found ?? sorted[0].offset;
  };
}

export function buildTripTimeline<L extends LegLike, E extends EventLike, S extends StayLike>(trip: TripLike<L, E, S>): TimelineEntry<L, E, S>[] {
  const points: { at: number; offset: number }[] = [];
  for (const leg of trip.legs) {
    const d = ms(leg.departAt);
    const a = ms(leg.arriveAt);
    if (d !== null && leg.departTimeZoneOffsetMinutes !== null) points.push({ at: d, offset: leg.departTimeZoneOffsetMinutes });
    if (a !== null && leg.arriveTimeZoneOffsetMinutes !== null) points.push({ at: a, offset: leg.arriveTimeZoneOffsetMinutes });
    // Прилетели — дальше живём по поясу прилёта, даже если час прилёта неизвестен.
    else if (d !== null && leg.arriveTimeZoneOffsetMinutes !== null) points.push({ at: d + 1, offset: leg.arriveTimeZoneOffsetMinutes });
  }
  for (const e of trip.events) {
    const s = ms(e.startAt);
    if (s !== null && e.startTimeZoneOffsetMinutes !== null) points.push({ at: s, offset: e.startTimeZoneOffsetMinutes });
  }
  const zoneAt = zoneResolver(points);

  const entries: TimelineEntry<L, E, S>[] = [];
  for (const leg of trip.legs) {
    const start = ms(leg.departAt);
    const arrive = ms(leg.arriveAt);
    const offset = leg.departTimeZoneOffsetMinutes ?? zoneAt(start === null ? null : start - 1);
    entries.push({
      key: `leg-${leg.id}`,
      kind: 'leg',
      item: leg,
      start,
      end: arrive ?? (start !== null ? start + DEFAULT_LEG_MS : null),
      offset,
      arriveOffset: leg.arriveTimeZoneOffsetMinutes ?? (arrive !== null ? zoneAt(arrive) : offset),
      dateOnly: null,
    });
  }
  for (const e of trip.events) {
    const start = ms(e.startAt);
    entries.push({
      key: `event-${e.id}`,
      kind: 'event',
      item: e,
      start,
      end: ms(e.endAt),
      offset: e.startTimeZoneOffsetMinutes ?? zoneAt(start ?? ms(e.dateOnly)),
      dateOnly: start === null && e.dateOnly ? e.dateOnly.slice(0, 10) : null,
    });
  }
  for (const s of trip.stays) {
    const start = ms(s.checkInAt);
    entries.push({ key: `stay-${s.id}`, kind: 'stay', item: s, start, end: ms(s.checkOutAt), offset: zoneAt(start), dateOnly: null });
  }

  entries.sort((a, b) => sortValue(a) - sortValue(b));

  // Событие без окончания — до следующего пункта с временем (не дольше 3 ч).
  const timed = entries.filter((e) => e.start !== null && e.kind !== 'stay');
  for (const e of entries) {
    if (e.kind !== 'event' || e.start === null || e.end !== null) continue;
    const next = timed.find((n) => n.start !== null && n.start > (e.start as number));
    e.end = next ? Math.min(next.start as number, e.start + MAX_OPEN_EVENT_MS) : e.start + DEFAULT_EVENT_MS;
  }
  return entries;
}

// Пункт только с датой — в начало своего дня; без даты вовсе — в конец.
function sortValue(e: TimelineEntry<unknown, unknown, unknown>): number {
  if (e.start !== null) return e.start;
  if (e.dateOnly) return new Date(`${e.dateOnly}T00:00:00Z`).getTime() - e.offset * MINUTE;
  return Number.MAX_SAFE_INTEGER;
}

export interface TripNow {
  // Пункт, который идёт прямо сейчас (событие/перелёт; проживание — только если
  // больше ничего не идёт).
  currentKey: string | null;
  // Ближайший следующий пункт.
  nextKey: string | null;
  // Где поставить отметку «Сейчас» в паузе между пунктами: перед nextKey.
  // false — сейчас идёт currentKey, отметка на нём.
  between: boolean;
  // Пояс, в котором руководитель сейчас (для «сейчас 15:42 по Пекину»).
  offset: number;
}

export function locateNow(entries: TimelineEntry<unknown, unknown, unknown>[], now: number): TripNow | null {
  const timed = entries.filter((e) => e.start !== null);
  if (timed.length === 0) return null;
  const first = timed[0].start as number;
  const last = Math.max(...timed.map((e) => e.end ?? (e.start as number)));
  if (now < first - TRIP_EDGE_MS || now > last + TRIP_EDGE_MS) return null;

  const foreground = timed.filter((e) => e.kind !== 'stay');
  const running = foreground.filter((e) => (e.start as number) <= now && now < (e.end ?? (e.start as number)));
  const current = running.at(-1) ?? timed.find((e) => e.kind === 'stay' && (e.start as number) <= now && e.end !== null && now < e.end) ?? null;
  const next = foreground.find((e) => (e.start as number) > now) ?? null;
  const zoneSource = current ?? [...timed].reverse().find((e) => (e.start as number) <= now) ?? next;
  const offset = zoneSource ? (zoneSource.kind === 'leg' && current !== zoneSource ? (zoneSource.arriveOffset ?? zoneSource.offset) : zoneSource.offset) : DEFAULT_TRIP_OFFSET_MINUTES;

  if (current && current.kind !== 'stay') return { currentKey: current.key, nextKey: next?.key ?? null, between: false, offset };
  // Свободное время (в т.ч. в гостинице) — отметка «Сейчас» перед следующим пунктом.
  if (next) return { currentKey: current?.key ?? null, nextKey: next.key, between: true, offset };
  return current ? { currentKey: current.key, nextKey: null, between: false, offset } : null;
}

// --- Форматирование по поясу места ---

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const ZONE_NAMES: Record<number, string> = { 300: 'Казахстан', 480: 'Китай', 180: 'Москва' };

function shifted(at: number, offset: number): Date {
  return new Date(at + offset * MINUTE);
}

export function zoneShortName(offset: number): string {
  if (ZONE_NAMES[offset]) return ZONE_NAMES[offset];
  const sign = offset < 0 ? '−' : '+';
  const abs = Math.abs(offset);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

export function zoneLabel(offset: number): string {
  const name = zoneShortName(offset);
  if (name.startsWith('UTC')) return name;
  const sign = offset < 0 ? '−' : '+';
  const abs = Math.abs(offset);
  return `${name}, UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

// «15:42» по времени места.
export function formatZoneTime(at: number, offset: number): string {
  const d = shifted(at, offset);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// Ключ дня по времени места — «2026-10-24».
export function zoneDayKey(at: number, offset: number): string {
  return shifted(at, offset).toISOString().slice(0, 10);
}

// «Пятница, 24 октября» из ключа дня.
export function formatDayKey(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  const weekday = WEEKDAYS[d.getUTCDay()];
  return `${weekday[0].toUpperCase()}${weekday.slice(1)}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function entryDayKey(e: TimelineEntry<unknown, unknown, unknown>): string | null {
  if (e.start !== null) return zoneDayKey(e.start, e.offset);
  return e.dateOnly;
}

// «через 1 ч 20 мин» / «через 5 мин».
export function formatUntil(from: number, to: number): string {
  const minutes = Math.max(0, Math.round((to - from) / MINUTE));
  if (minutes < 1) return 'сейчас';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `через ${days} дн${hours ? ` ${hours} ч` : ''}`;
  if (hours > 0) return `через ${hours} ч${mins ? ` ${mins} мин` : ''}`;
  return `через ${mins} мин`;
}

export interface TimelineDay<L, E, S> {
  // null — пункты без даты.
  dayKey: string | null;
  entries: TimelineEntry<L, E, S>[];
}

export function groupTimelineByDay<L, E, S>(entries: TimelineEntry<L, E, S>[]): TimelineDay<L, E, S>[] {
  const days: TimelineDay<L, E, S>[] = [];
  for (const e of entries) {
    const key = entryDayKey(e);
    const last = days.at(-1);
    if (last && last.dayKey === key) last.entries.push(e);
    else days.push({ dayKey: key, entries: [e] });
  }
  return days;
}

// Пояс дня — пояс первого пункта со временем (для заголовка дня).
export function dayOffset<L, E, S>(day: TimelineDay<L, E, S>): number {
  return (day.entries.find((e) => e.start !== null) ?? day.entries[0]).offset;
}

function timeIn(at: number, offset: number, base: number, dayKey: string | null): string {
  const time = formatZoneTime(at, offset);
  const otherDay = dayKey !== null && zoneDayKey(at, offset) !== dayKey;
  const d = shifted(at, offset);
  const date = otherDay ? `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')} ` : '';
  return `${date}${time}${offset !== base ? ` (${zoneShortName(offset)})` : ''}`;
}

// Строка времени пункта по поясу места: «09:00–10:30», «13:00 → 21:30 (Китай)»,
// «заезд 23:00 · выезд 27.10 12:00». base — пояс дня: совпадающий пояс не пишется.
export function describeEntryTime<L, E, S>(e: TimelineEntry<L, E, S>, base: number): string {
  const dayKey = entryDayKey(e);
  if (e.start === null) return e.dateOnly ? 'время не подтверждено' : 'дата не подтверждена';
  if (e.kind === 'leg') {
    const arrive = (e.item as LegLike).arriveAt ? ms((e.item as LegLike).arriveAt) : null;
    const from = timeIn(e.start, e.offset, base, dayKey);
    return arrive !== null ? `${from} → ${timeIn(arrive, e.arriveOffset ?? e.offset, base, dayKey)}` : from;
  }
  if (e.kind === 'stay') {
    const out = (e.item as StayLike).checkOutAt ? ms((e.item as StayLike).checkOutAt) : null;
    // Выезд — обычно в другой день: дата пишется всегда, пояс — как у заезда.
    return `заезд ${timeIn(e.start, e.offset, base, dayKey)}${out !== null ? ` · выезд ${timeIn(out, e.offset, e.offset, '')}` : ''}`;
  }
  const end = (e.item as EventLike).endAt ? ms((e.item as EventLike).endAt) : null;
  const start = timeIn(e.start, e.offset, base, dayKey);
  if (end === null) return start;
  const endText = zoneDayKey(end, e.offset) === dayKey ? formatZoneTime(end, e.offset) : timeIn(end, e.offset, e.offset, dayKey);
  return `${start}–${endText}`;
}

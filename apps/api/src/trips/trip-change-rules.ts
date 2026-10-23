import type { TripPeriodPrecision } from '@prisma/client';
import type { ComposedContact, ComposedEvent, ComposedLeg, ComposedStay, ComposedTrip } from './trip-compose';

// Приоритет 2 ТЗ — "Добавить информацию всегда обновляет выбранную поездку,
// но никогда тихо не меняет подтверждённые даты/время/адреса/состав".
// Поэтому при обновлении СУЩЕСТВУЮЩЕЙ поездки новые перелёты/события/
// проживания/контакты из материалов НИКОГДА не пишутся прямо — они всегда
// предложения (ProposedChange), даже если выглядят бесспорными. Единственное,
// что здесь решается "эвристически, не предложением" — факты (ExtractedFact,
// см. trip-run-execution.service.ts) — они по дизайну уже "мягкий",
// непротиворечащий состав поездки слой.

// entityId задан — уточнение УЖЕ записанной сущности (23.10.2026: билет к
// перелёту из программы не должен давать второй перелёт): proposedValue —
// только изменившиеся поля, previousValue — их прежние значения.
export interface ProposedEntityChange {
  entityType: 'TRIP_LEG' | 'TRIP_EVENT' | 'TRIP_STAY' | 'TRIP_CONTACT';
  proposedValue: ComposedLeg | ComposedEvent | ComposedStay | ComposedContact | Record<string, unknown>;
  materialId: string | null;
  entityId?: string;
  previousValue?: Record<string, unknown>;
  reason?: string;
  consequences?: string;
}

export interface ProposedTripFieldChange {
  fieldKey: 'period' | 'purposeSummary';
  previousValue: unknown;
  proposedValue: unknown;
  reason: string;
  consequences: string;
}

export interface ExistingTripSnapshot {
  periodStart: Date | null;
  periodEnd: Date | null;
  periodPrecision: TripPeriodPrecision;
  purposeSummary: string | null;
}

function widensRange(existing: ExistingTripSnapshot, composed: ComposedTrip): boolean {
  if (!composed.periodStart || !composed.periodEnd) return false;
  if (existing.periodPrecision === 'UNKNOWN' || !existing.periodStart || !existing.periodEnd) return true;
  return composed.periodStart.getTime() < existing.periodStart.getTime() || composed.periodEnd.getTime() > existing.periodEnd.getTime();
}

export interface ExistingLeg {
  id: string;
  mode: string;
  fromLocation: string | null;
  toLocation: string | null;
  departAt: Date | null;
  departTimeZoneOffsetMinutes: number | null;
  arriveAt: Date | null;
  arriveTimeZoneOffsetMinutes: number | null;
  carrier: string | null;
  referenceCode: string | null;
  bookingStatus: string;
}
export interface ExistingEvent {
  id: string;
  title: string;
  startAt: Date | null;
  startTimeZoneOffsetMinutes: number | null;
  dateOnly: Date | null;
  endAt: Date | null;
  location: string | null;
  notes: string | null;
}
export interface ExistingStay {
  id: string;
  name: string | null;
  address: string | null;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  bookingStatus: string;
}
export interface ExistingContact {
  id: string;
  name: string;
  organization: string | null;
  email: string | null;
  phone: string | null;
}
export interface ExistingEntities {
  legs: ExistingLeg[];
  events: ExistingEvent[];
  stays: ExistingStay[];
  contacts: ExistingContact[];
}

const NO_ENTITIES: ExistingEntities = { legs: [], events: [], stays: [], contacts: [] };
const HOUR_MS = 3_600_000;
// Билет и программа расходятся во времени вылета (программа — «ориентир»,
// билет — факт), но не на полдня: в пределах 6 ч это тот же рейс.
const LEG_MATCH_WINDOW_MS = 6 * HOUR_MS;
const EVENT_MATCH_WINDOW_MS = 15 * 60_000;
const STAY_MATCH_WINDOW_MS = 24 * HOUR_MS;
const BOOKING_RANK: Record<string, number> = { BOOKED: 2, PROPOSED: 1, UNCONFIRMED: 0 };

function ms(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function near(a: string | Date | null, b: string | Date | null, window: number): boolean {
  const x = ms(a);
  const y = ms(b);
  return x !== null && y !== null && Math.abs(x - y) <= window;
}

function norm(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
}

function digits(text: string | null | undefined): string {
  return (text ?? '').replace(/\D+/g, '');
}

// Ближайшая по времени свободная сущность среди подходящих (одна запись — одно сопоставление).
function closest<T extends { id: string }>(candidates: T[], used: Set<string>, distance: (c: T) => number | null): T | undefined {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    if (used.has(c.id)) continue;
    const d = distance(c);
    if (d !== null && d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  if (best) used.add(best.id);
  return best;
}

function distanceMs(a: string | Date | null, b: string | Date | null, window: number): number | null {
  return near(a, b, window) ? Math.abs(ms(a)! - ms(b)!) : null;
}

class Patch {
  readonly next: Record<string, unknown> = {};
  readonly prev: Record<string, unknown> = {};

  // Время — источник правды новый материал (билет/бронь точнее программы).
  moment(key: string, value: string | null, current: Date | null, offsetKey?: string, offset?: number | null, currentOffset?: number | null) {
    if (value === null || ms(value) === null) return;
    const changedTime = ms(value) !== ms(current);
    const changedOffset = offsetKey !== undefined && offset != null && offset !== currentOffset;
    if (!changedTime && !changedOffset) return;
    this.next[key] = value;
    this.prev[key] = iso(current);
    if (offsetKey) {
      this.next[offsetKey] = offset ?? currentOffset ?? null;
      this.prev[offsetKey] = currentOffset ?? null;
    }
  }

  // Текст — только дополняется: переформулировка той же сути другим материалом не повод для предложения.
  fill(key: string, value: string | null, current: string | null) {
    if (value && !current?.trim()) {
      this.next[key] = value;
      this.prev[key] = current;
    }
  }

  // Реквизиты брони — заменяются, если новый материал называет другие.
  replace(key: string, value: string | null, current: string | null) {
    if (value && norm(value) !== norm(current)) {
      this.next[key] = value;
      this.prev[key] = current;
    }
  }

  booking(value: string, current: string) {
    if ((BOOKING_RANK[value] ?? 0) > (BOOKING_RANK[current] ?? 0)) {
      this.next.bookingStatus = value;
      this.prev.bookingStatus = current;
    }
  }

  get empty(): boolean {
    return Object.keys(this.next).length === 0;
  }
}

function fmtDay(value: Date | null, offsetMinutes: number | null): string {
  if (!value) return '';
  const d = new Date(value.getTime() + (offsetMinutes ?? 300) * 60_000);
  return ` ${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function matchLeg(leg: ComposedLeg, legs: ExistingLeg[], used: Set<string>): ExistingLeg | undefined {
  const sameMode = legs.filter((l) => l.mode === leg.mode || l.mode === 'OTHER' || leg.mode === 'OTHER');
  return closest(sameMode, used, (l) => distanceMs(leg.departAt, l.departAt, LEG_MATCH_WINDOW_MS) ?? distanceMs(leg.arriveAt, l.arriveAt, LEG_MATCH_WINDOW_MS));
}

function legUpdate(leg: ComposedLeg, existing: ExistingLeg): ProposedEntityChange | null {
  const p = new Patch();
  p.moment('departAt', leg.departAt, existing.departAt, 'departTimeZoneOffsetMinutes', leg.departTimeZoneOffsetMinutes, existing.departTimeZoneOffsetMinutes);
  p.moment('arriveAt', leg.arriveAt, existing.arriveAt, 'arriveTimeZoneOffsetMinutes', leg.arriveTimeZoneOffsetMinutes, existing.arriveTimeZoneOffsetMinutes);
  p.fill('fromLocation', leg.fromLocation, existing.fromLocation);
  p.fill('toLocation', leg.toLocation, existing.toLocation);
  p.replace('carrier', leg.carrier, existing.carrier);
  p.replace('referenceCode', leg.referenceCode, existing.referenceCode);
  p.booking(leg.bookingStatus, existing.bookingStatus);
  if (p.empty) return null;
  const route = `${existing.fromLocation ?? '?'} → ${existing.toLocation ?? '?'}${fmtDay(existing.departAt, existing.departTimeZoneOffsetMinutes)}`;
  return {
    entityType: 'TRIP_LEG',
    entityId: existing.id,
    proposedValue: p.next,
    previousValue: p.prev,
    materialId: leg.sourceMaterialId,
    reason: `Уточнение уже записанного перелёта/переезда ${route}`,
    consequences: 'Обновится существующая запись — второй перелёт не появится',
  };
}

function matchEvent(event: ComposedEvent, events: ExistingEvent[], used: Set<string>): ExistingEvent | undefined {
  if (event.startAt) return closest(events, used, (e) => distanceMs(event.startAt, e.startAt, EVENT_MATCH_WINDOW_MS));
  if (event.dateOnly) {
    const day = event.dateOnly.slice(0, 10);
    return closest(events, used, (e) => (e.dateOnly && e.dateOnly.toISOString().slice(0, 10) === day && norm(e.title) === norm(event.title) ? 0 : null));
  }
  return closest(events, used, (e) => (!e.startAt && !e.dateOnly && norm(e.title) === norm(event.title) ? 0 : null));
}

function eventUpdate(event: ComposedEvent, existing: ExistingEvent): ProposedEntityChange | null {
  const p = new Patch();
  p.moment('startAt', event.startAt, existing.startAt, 'startTimeZoneOffsetMinutes', event.startTimeZoneOffsetMinutes, existing.startTimeZoneOffsetMinutes);
  p.moment('endAt', event.endAt, existing.endAt);
  p.fill('location', event.location, existing.location);
  p.fill('notes', event.notes, existing.notes);
  if (p.empty) return null;
  return {
    entityType: 'TRIP_EVENT',
    entityId: existing.id,
    proposedValue: p.next,
    previousValue: p.prev,
    materialId: event.sourceMaterialId,
    reason: `Уточнение уже записанного события «${existing.title}»`,
    consequences: 'Обновится существующее событие — дубль в программе не появится',
  };
}

function matchStay(stay: ComposedStay, stays: ExistingStay[], used: Set<string>): ExistingStay | undefined {
  return closest(stays, used, (s) => distanceMs(stay.checkInAt, s.checkInAt, STAY_MATCH_WINDOW_MS) ?? distanceMs(stay.checkOutAt, s.checkOutAt, STAY_MATCH_WINDOW_MS));
}

function stayUpdate(stay: ComposedStay, existing: ExistingStay): ProposedEntityChange | null {
  const p = new Patch();
  p.moment('checkInAt', stay.checkInAt, existing.checkInAt);
  p.moment('checkOutAt', stay.checkOutAt, existing.checkOutAt);
  p.fill('name', stay.name, existing.name);
  p.fill('address', stay.address, existing.address);
  p.booking(stay.bookingStatus, existing.bookingStatus);
  if (p.empty) return null;
  return {
    entityType: 'TRIP_STAY',
    entityId: existing.id,
    proposedValue: p.next,
    previousValue: p.prev,
    materialId: stay.sourceMaterialId,
    reason: `Уточнение уже записанного проживания${existing.name ? ` «${existing.name}»` : ''}`,
    consequences: 'Обновится существующая запись — второе проживание не появится',
  };
}

function matchContact(contact: ComposedContact, contacts: ExistingContact[], used: Set<string>): ExistingContact | undefined {
  return closest(contacts, used, (c) => {
    if (norm(c.name) && norm(c.name) === norm(contact.name)) return 0;
    if (contact.email && c.email && contact.email.toLowerCase() === c.email.toLowerCase()) return 0;
    const phone = digits(contact.phone);
    return phone.length >= 7 && phone === digits(c.phone) ? 0 : null;
  });
}

function contactUpdate(contact: ComposedContact, existing: ExistingContact): ProposedEntityChange | null {
  const p = new Patch();
  p.fill('organization', contact.organization, existing.organization);
  p.fill('email', contact.email, existing.email);
  p.fill('phone', contact.phone, existing.phone);
  if (p.empty) return null;
  return {
    entityType: 'TRIP_CONTACT',
    entityId: existing.id,
    proposedValue: p.next,
    previousValue: p.prev,
    materialId: contact.sourceMaterialId,
    reason: `Уточнение контакта ${existing.name}`,
    consequences: 'Дополнится существующий контакт',
  };
}

// Новые материалы к существующей поездке: то, что уже записано (тот же рейс,
// то же событие, та же бронь, тот же человек), — предложение уточнить
// запись или ничего, если нового нет; остальное — предложение новой записи.
export function buildEntityChanges(composed: ComposedTrip, existing: ExistingEntities = NO_ENTITIES): ProposedEntityChange[] {
  const changes: ProposedEntityChange[] = [];
  const used = new Set<string>();
  const add = (fresh: ProposedEntityChange, matched: { id: string } | undefined, update: () => ProposedEntityChange | null) => {
    if (!matched) changes.push(fresh);
    else {
      const change = update();
      if (change) changes.push(change);
    }
  };
  for (const leg of composed.legs) {
    const m = matchLeg(leg, existing.legs, used);
    add({ entityType: 'TRIP_LEG', proposedValue: leg, materialId: leg.sourceMaterialId }, m, () => legUpdate(leg, m!));
  }
  for (const event of composed.events) {
    const m = matchEvent(event, existing.events, used);
    add({ entityType: 'TRIP_EVENT', proposedValue: event, materialId: event.sourceMaterialId }, m, () => eventUpdate(event, m!));
  }
  for (const stay of composed.stays) {
    const m = matchStay(stay, existing.stays, used);
    add({ entityType: 'TRIP_STAY', proposedValue: stay, materialId: stay.sourceMaterialId }, m, () => stayUpdate(stay, m!));
  }
  for (const contact of composed.contacts) {
    const m = matchContact(contact, existing.contacts, used);
    add({ entityType: 'TRIP_CONTACT', proposedValue: contact, materialId: contact.sourceMaterialId }, m, () => contactUpdate(contact, m!));
  }
  return changes;
}

// Раздел 7 ТЗ — диф показывает "было → станет → источник → последствия".
// Здесь только два вида полевых предложений (период и краткое описание) —
// намеренно узкий список: остальные поля Trip (title/humanCode) правятся
// только вручную (PATCH), агент их не предлагает — риск неудачно
// переименовать поездку по кривому summaryHint выше цены просто не
// предлагать.
export function buildTripFieldChanges(existing: ExistingTripSnapshot, composed: ComposedTrip): ProposedTripFieldChange[] {
  const changes: ProposedTripFieldChange[] = [];

  if (widensRange(existing, composed)) {
    changes.push({
      fieldKey: 'period',
      previousValue: { periodStart: existing.periodStart, periodEnd: existing.periodEnd, periodPrecision: existing.periodPrecision },
      proposedValue: { periodStart: composed.periodStart, periodEnd: composed.periodEnd, periodPrecision: composed.periodPrecision },
      reason: 'Новый материал указывает на даты, расширяющие или уточняющие текущий период поездки',
      consequences: 'Изменит отображаемые даты начала/окончания поездки и её временной статус (скоро/идёт сейчас/завершена)',
    });
  }

  if (composed.summaryHint && composed.summaryHint !== existing.purposeSummary && !existing.purposeSummary) {
    changes.push({
      fieldKey: 'purposeSummary',
      previousValue: existing.purposeSummary,
      proposedValue: composed.summaryHint,
      reason: 'Описание цели поездки ещё не было заполнено',
      consequences: 'Появится краткое описание цели поездки в карточке',
    });
  }

  return changes;
}

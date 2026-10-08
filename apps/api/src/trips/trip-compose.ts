import type { TripExtractedContact, TripExtractedFactEntry, TripExtractedLeg, TripExtractedStay, TripExtractionDraft, TripExtractedEvent } from './trip-extraction';

// Агент поездок (ТЗ 08.10.2026, раздел 4/5) — чистая сборка карточки поездки
// из извлечённых по каждому материалу фактов. Раздел 4: "статус времени
// поездки и готовность информации — разные признаки" — здесь считается
// именно период (periodStart/periodEnd/periodPrecision), на основе которого
// EventsService/TripsService позже вычисляет статус при чтении, не хранит
// его отдельно. Раздел 5: конфликт показывает оба значения с источником —
// в этой версии конфликты между материалами не схлопываются в одно
// значение (сведение факт→факт не делается), а просто остаются отдельными
// TripLeg/TripEvent/TripStay с разным sourceMaterialId — противоречие видно
// пользователю как два разных пункта программы, не как потерянная правда.
//
// Composed*-типы НЕ алиасы TripExtracted*-типов (были до 08.10.2026) — у
// TripExtracted* урезанный набор полей (см. комментарий в trip-extraction.ts
// про лимит Anthropic на union-параметры тула), а downstream-код
// (trip-run-execution.service.ts/trip-changes.service.ts) пишет в БД полный
// набор колонок (departTimeZoneOffsetMinutes/carrier/referenceCode/
// TripStay.name/TripEvent.dateOnly/organization). toComposedLeg/Event/Stay/
// Contact ниже — единственное место, где урезанный ответ модели
// разворачивается в полную форму для записи.

export interface MaterialDraft {
  materialId: string;
  fileLabel: string;
  draft: TripExtractionDraft;
}

export interface ComposedLeg {
  mode: TripExtractedLeg['mode'];
  fromLocation: string | null;
  toLocation: string | null;
  departAt: string | null;
  departTimeZoneOffsetMinutes: number | null;
  arriveAt: string | null;
  arriveTimeZoneOffsetMinutes: number | null;
  carrier: string | null;
  referenceCode: string | null;
  bookingStatus: TripExtractedLeg['bookingStatus'];
  sourceMaterialId: string;
}

export interface ComposedEvent {
  title: string;
  startAt: string | null;
  startTimeZoneOffsetMinutes: number | null;
  dateOnly: string | null;
  endAt: string | null;
  location: string | null;
  notes: string | null;
  sourceMaterialId: string;
}

export interface ComposedStay {
  name: string | null;
  address: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  bookingStatus: TripExtractedStay['bookingStatus'];
  sourceMaterialId: string;
}

export type ComposedContact = TripExtractedContact & { organization: string | null; sourceMaterialId: string };
export type ComposedFact = TripExtractedFactEntry & { sourceMaterialId: string };

export interface ComposedTrip {
  destinationHint: string | null;
  summaryHint: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  periodPrecision: 'UNKNOWN' | 'APPROXIMATE' | 'EXACT';
  legs: ComposedLeg[];
  events: ComposedEvent[];
  stays: ComposedStay[];
  contacts: ComposedContact[];
  facts: ComposedFact[];
  issues: string[];
}

export function parseDateOrNull(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const parseDate = parseDateOrNull;

// Модель кодирует известное смещение часового пояса прямо в ISO-строке
// ("2026-12-01T06:00:00+05:00") вместо отдельного числового параметра —
// экономит union-параметр схемы тула (см. trip-extraction.ts). Здесь это
// смещение достаётся обратно для записи в departTimeZoneOffsetMinutes и
// аналогичные колонки. 'Z' — смещение 0. Без суффикса смещения — null
// (неизвестно), не 0: предполагать UTC без оснований не лучше, чем
// предполагать Алматы.
export function extractUtcOffsetMinutes(value: string | null): number | null {
  if (!value) return null;
  if (/Z$/.test(value)) return 0;
  const match = value.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

// "YYYY-MM-DD" ровно — отличает "известна только дата" от полного
// ISO-момента (раздел 4 ТЗ — unknown-time событие своей группой, без
// придуманного часа).
export function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toComposedLeg(raw: TripExtractedLeg, sourceMaterialId: string): ComposedLeg {
  return {
    mode: raw.mode,
    fromLocation: raw.fromLocation,
    toLocation: raw.toLocation,
    departAt: raw.departAt,
    departTimeZoneOffsetMinutes: extractUtcOffsetMinutes(raw.departAt),
    arriveAt: raw.arriveAt,
    arriveTimeZoneOffsetMinutes: extractUtcOffsetMinutes(raw.arriveAt),
    carrier: raw.bookingReference,
    referenceCode: null,
    bookingStatus: raw.bookingStatus,
    sourceMaterialId,
  };
}

function toComposedEvent(raw: TripExtractedEvent, sourceMaterialId: string): ComposedEvent {
  const startIsDateOnly = Boolean(raw.startAt && isDateOnly(raw.startAt));
  return {
    title: raw.title,
    startAt: startIsDateOnly ? null : raw.startAt,
    startTimeZoneOffsetMinutes: startIsDateOnly ? null : extractUtcOffsetMinutes(raw.startAt),
    dateOnly: startIsDateOnly ? raw.startAt : null,
    endAt: raw.endAt,
    location: raw.location,
    notes: null,
    sourceMaterialId,
  };
}

function toComposedStay(raw: TripExtractedStay, sourceMaterialId: string): ComposedStay {
  return {
    name: null,
    address: raw.address,
    checkInAt: raw.checkInAt,
    checkOutAt: raw.checkOutAt,
    bookingStatus: raw.bookingStatus,
    sourceMaterialId,
  };
}

function toComposedContact(raw: TripExtractedContact, sourceMaterialId: string): ComposedContact {
  return { ...raw, organization: null, sourceMaterialId };
}

export function composeTripFromMaterials(materials: MaterialDraft[]): ComposedTrip {
  const legs: ComposedLeg[] = [];
  const events: ComposedEvent[] = [];
  const stays: ComposedStay[] = [];
  const contacts: ComposedContact[] = [];
  const facts: ComposedFact[] = [];
  const issues: string[] = [];

  let destinationHint: string | null = null;
  let summaryHint: string | null = null;
  const exactDates: Date[] = [];
  const approxDates: Date[] = [];

  for (const { materialId, fileLabel, draft } of materials) {
    if (!destinationHint && draft.destinationHint) destinationHint = draft.destinationHint;
    if (!summaryHint && draft.summaryHint) summaryHint = draft.summaryHint;

    for (const leg of draft.legs) {
      const composed = toComposedLeg(leg, materialId);
      legs.push(composed);
      const depart = parseDate(composed.departAt);
      const arrive = parseDate(composed.arriveAt);
      if (depart) exactDates.push(depart);
      if (arrive) exactDates.push(arrive);
    }
    for (const event of draft.events) {
      const composed = toComposedEvent(event, materialId);
      events.push(composed);
      const start = parseDate(composed.startAt);
      if (start) exactDates.push(start);
      else {
        const dateOnly = parseDate(composed.dateOnly);
        if (dateOnly) approxDates.push(dateOnly);
      }
    }
    for (const stay of draft.stays) {
      const composed = toComposedStay(stay, materialId);
      stays.push(composed);
      const checkIn = parseDate(composed.checkInAt);
      const checkOut = parseDate(composed.checkOutAt);
      if (checkIn) exactDates.push(checkIn);
      if (checkOut) exactDates.push(checkOut);
    }
    for (const contact of draft.contacts) contacts.push(toComposedContact(contact, materialId));
    for (const fact of draft.facts) facts.push({ ...fact, sourceMaterialId: materialId });
    for (const issue of draft.issues) issues.push(`${fileLabel}: ${issue}`);
  }

  if (legs.length === 0 && events.length === 0 && stays.length === 0) {
    issues.push('Не удалось извлечь ни перелётов/переездов, ни программы, ни проживания ни из одного материала — карточка создана только с тем, что есть.');
  }

  const allDates = [...exactDates, ...approxDates];
  const periodStart = allDates.length > 0 ? new Date(Math.min(...allDates.map((d) => d.getTime()))) : null;
  const periodEnd = allDates.length > 0 ? new Date(Math.max(...allDates.map((d) => d.getTime()))) : null;
  const periodPrecision: ComposedTrip['periodPrecision'] = exactDates.length > 0 ? 'EXACT' : approxDates.length > 0 ? 'APPROXIMATE' : 'UNKNOWN';

  return { destinationHint, summaryHint, periodStart, periodEnd, periodPrecision, legs, events, stays, contacts, facts, issues };
}

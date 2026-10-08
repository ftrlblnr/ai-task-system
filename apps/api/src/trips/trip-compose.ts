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

export interface MaterialDraft {
  materialId: string;
  fileLabel: string;
  draft: TripExtractionDraft;
}

export type ComposedLeg = TripExtractedLeg & { sourceMaterialId: string };
export type ComposedEvent = TripExtractedEvent & { sourceMaterialId: string };
export type ComposedStay = TripExtractedStay & { sourceMaterialId: string };
export type ComposedContact = TripExtractedContact & { sourceMaterialId: string };
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
      legs.push({ ...leg, sourceMaterialId: materialId });
      const depart = parseDate(leg.departAt);
      const arrive = parseDate(leg.arriveAt);
      if (depart) exactDates.push(depart);
      if (arrive) exactDates.push(arrive);
    }
    for (const event of draft.events) {
      events.push({ ...event, sourceMaterialId: materialId });
      const start = parseDate(event.startAt);
      if (start) exactDates.push(start);
      else {
        const dateOnly = parseDate(event.dateOnly);
        if (dateOnly) approxDates.push(dateOnly);
      }
    }
    for (const stay of draft.stays) {
      stays.push({ ...stay, sourceMaterialId: materialId });
      const checkIn = parseDate(stay.checkInAt);
      const checkOut = parseDate(stay.checkOutAt);
      if (checkIn) exactDates.push(checkIn);
      if (checkOut) exactDates.push(checkOut);
    }
    for (const contact of draft.contacts) contacts.push({ ...contact, sourceMaterialId: materialId });
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

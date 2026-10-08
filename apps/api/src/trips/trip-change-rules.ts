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

export interface ProposedEntityChange {
  entityType: 'TRIP_LEG' | 'TRIP_EVENT' | 'TRIP_STAY' | 'TRIP_CONTACT';
  proposedValue: ComposedLeg | ComposedEvent | ComposedStay | ComposedContact;
  materialId: string | null;
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

export function buildEntityChanges(composed: ComposedTrip): ProposedEntityChange[] {
  const changes: ProposedEntityChange[] = [];
  for (const leg of composed.legs) changes.push({ entityType: 'TRIP_LEG', proposedValue: leg, materialId: leg.sourceMaterialId });
  for (const event of composed.events) changes.push({ entityType: 'TRIP_EVENT', proposedValue: event, materialId: event.sourceMaterialId });
  for (const stay of composed.stays) changes.push({ entityType: 'TRIP_STAY', proposedValue: stay, materialId: stay.sourceMaterialId });
  for (const contact of composed.contacts) changes.push({ entityType: 'TRIP_CONTACT', proposedValue: contact, materialId: contact.sourceMaterialId });
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

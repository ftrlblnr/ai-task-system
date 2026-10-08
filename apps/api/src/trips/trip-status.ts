import type { TripPeriodPrecision } from '@prisma/client';

// Раздел 4/6 ТЗ — "статус времени поездки и готовность информации — разные
// признаки". Статус времени вычисляется на чтении из дат + текущего
// момента, не хранится отдельным полем. Отменённые поездки — отдельная
// категория, никогда не попадают в COMPLETED, даже если их период в прошлом
// (раздел 6: "отменённые поездки хранятся отдельно и никогда не считаются
// завершёнными посещениями").
export type TripTimeStatus = 'CANCELLED' | 'NO_CONFIRMED_DATES' | 'UPCOMING' | 'ONGOING' | 'COMPLETED';

export interface TripTimeStatusInput {
  cancelledAt: Date | null;
  periodPrecision: TripPeriodPrecision;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export function computeTripTimeStatus(trip: TripTimeStatusInput, now: Date = new Date()): TripTimeStatus {
  if (trip.cancelledAt) return 'CANCELLED';
  if (trip.periodPrecision === 'UNKNOWN' || !trip.periodStart) return 'NO_CONFIRMED_DATES';
  const end = trip.periodEnd ?? trip.periodStart;
  if (now.getTime() < trip.periodStart.getTime()) return 'UPCOMING';
  if (now.getTime() > end.getTime()) return 'COMPLETED';
  return 'ONGOING';
}

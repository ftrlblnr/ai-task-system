import { Injectable } from '@nestjs/common';
import { CalendarPolicyService } from './calendar-policy.service';
import { findAvailableSlots, type SlotSearchResult } from './calendar-availability';
import { GoogleFreeBusyService } from './google-freebusy.service';

// FIND_SLOTS (раздел 6 ТЗ, Этап 1) — оркестратор: политика + занятость →
// чистая функция расчёта. Сам расчёт в calendar-availability.ts (без DI),
// здесь только сборка входных данных.
@Injectable()
export class CalendarAvailabilityService {
  constructor(
    private readonly policy: CalendarPolicyService,
    private readonly freeBusy: GoogleFreeBusyService,
  ) {}

  async findSlots(ownerId: string, from: Date, to: Date, durationMinutes: number, maxResults?: number): Promise<SlotSearchResult> {
    const [policy, busyResult] = await Promise.all([this.policy.getOrDefault(ownerId), this.freeBusy.queryBusy(ownerId, from, to)]);
    const busy = busyResult.status === 'OK' ? busyResult.busy : 'UNKNOWN';
    return findAvailableSlots(from, to, durationMinutes, policy, busy, new Date(), maxResults);
  }
}

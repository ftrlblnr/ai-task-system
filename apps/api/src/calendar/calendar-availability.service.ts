import { Injectable, Optional } from '@nestjs/common';
import { CalendarPolicyService } from './calendar-policy.service';
import {
  findAvailableSlots,
  type AvailableSlot,
  type BusyInterval,
  type SlotSearchResult,
} from './calendar-availability';
import { GoogleFreeBusyService } from './google-freebusy.service';
import { EventsService } from './events.service';

// FIND_SLOTS (раздел 6 ТЗ, Этап 1) — оркестратор: политика + занятость →
// чистая функция расчёта. Сам расчёт в calendar-availability.ts (без DI),
// здесь только сборка входных данных.
@Injectable()
export class CalendarAvailabilityService {
  constructor(
    private readonly policy: CalendarPolicyService,
    private readonly freeBusy: GoogleFreeBusyService,
    // Единый агент A3 — без него (юнит-тесты findSlots) не нужен.
    @Optional() private readonly events?: EventsService,
  ) {}

  async findSlots(
    ownerId: string,
    from: Date,
    to: Date,
    durationMinutes: number,
    maxResults?: number,
  ): Promise<SlotSearchResult> {
    const [policy, busyResult] = await Promise.all([
      this.policy.getOrDefault(ownerId),
      this.freeBusy.queryBusy(ownerId, from, to),
    ]);
    const busy = busyResult.status === 'OK' ? busyResult.busy : 'UNKNOWN';
    return findAvailableSlots(
      from,
      to,
      durationMinutes,
      policy,
      busy,
      new Date(),
      maxResults,
    );
  }

  // Единый агент A3 (поиск времени из чата): findSlots выше без Google
  // отвечает «неизвестно» — у руководителя без подключённого Google агент не
  // нашёл бы ни одного окна. Здесь занятость — подтверждённые события
  // календаря Адъютанта (источник правды, двусторонне синхронизирован с
  // Google) плюс freeBusy Google, если он ответил; googleChecked честно
  // говорит модели, проверен ли Google в этот раз.
  async findSlotsForAgent(
    ownerId: string,
    from: Date,
    to: Date,
    durationMinutes: number,
    maxResults: number,
  ): Promise<{ slots: AvailableSlot[]; googleChecked: boolean }> {
    const [policy, google, own] = await Promise.all([
      this.policy.getOrDefault(ownerId),
      this.freeBusy.queryBusy(ownerId, from, to),
      this.events
        ? this.events.findBetween(ownerId, from, to)
        : Promise.resolve([]),
    ]);
    const busy: BusyInterval[] = [
      ...own.map((e) => ({ start: e.startAt, end: e.endAt })),
      ...(google.status === 'OK' ? google.busy : []),
    ];
    const result = findAvailableSlots(
      from,
      to,
      durationMinutes,
      policy,
      busy,
      new Date(),
      maxResults,
    );
    return {
      slots: result.status === 'OK' ? result.slots : [],
      googleChecked: google.status === 'OK',
    };
  }
}

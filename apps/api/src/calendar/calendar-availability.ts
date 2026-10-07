// Календарный агент, раздел 11 ТЗ — расчёт доступных слотов. Чистая
// функция (без DI, без Google) — тот же приём, что reply-status.ts/
// mail-action-rules.ts: бизнес-правило тестируется без живого API.
//
// Этот деплой — один руководитель с одним подключённым календарём
// (EventsService: "личный календарь руководителя", не общий корпоративный).
// Поэтому "обязательные участники" этапа 1 это ровно один источник —
// занятость самого владельца; многоучастниковый FIND_SLOTS (раздел 10 ТЗ)
// технически расширяет этот же busy-массив объединением интервалов
// нескольких источников, когда появятся другие подключённые календари —
// сигнатура уже рассчитана на это (busy — один объединённый список, не
// per-участник).

export interface WorkingHoursRule {
  // 0 = воскресенье..6 = суббота — то же соглашение, что Date#getUTCDay(),
  // здесь считается по ЛОКАЛЬНОМУ (со смещением политики) времени, не UTC.
  weekday: number;
  startMinute: number; // минут от локальной полуночи
  endMinute: number;
}

export interface AvailabilityPolicy {
  // Фиксированное смещение (раздел 24 ТЗ: UTC+5, Asia/Almaty, без DST) —
  // тот же принцип, что common/timezone.ts; полноценный IANA-часовой пояс
  // с DST не нужен для единственного офиса без летнего времени.
  timeZoneOffsetMinutes: number;
  workingHours: WorkingHoursRule[];
  bufferMinutes: number;
  minNoticeHours: number;
  slotStepMinutes: number;
}

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface AvailableSlot {
  start: Date;
  end: Date;
}

export type SlotSearchResult =
  | { status: 'OK'; slots: AvailableSlot[] }
  // Раздел 11 ТЗ — "недоступность одного обязательного источника даёт
  // UNKNOWN, а не пустой busy-массив": отличать "свободно везде" от "не
  // смогли проверить" — вызывающий код не должен подтверждать бронь на
  // основании UNKNOWN.
  | { status: 'UNKNOWN' };

function localMinuteOfDay(date: Date, offsetMinutes: number): number {
  const localMs = date.getTime() + offsetMinutes * 60 * 1000;
  const local = new Date(localMs);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function localWeekday(date: Date, offsetMinutes: number): number {
  const localMs = date.getTime() + offsetMinutes * 60 * 1000;
  return new Date(localMs).getUTCDay();
}

function overlapsAnyBusy(start: Date, end: Date, busy: BusyInterval[], bufferMs: number): boolean {
  const bufferedStart = start.getTime() - bufferMs;
  const bufferedEnd = end.getTime() + bufferMs;
  return busy.some((b) => bufferedStart < b.end.getTime() && bufferedEnd > b.start.getTime());
}

function fitsWorkingHours(start: Date, end: Date, policy: AvailabilityPolicy): boolean {
  const weekday = localWeekday(start, policy.timeZoneOffsetMinutes);
  const startMinute = localMinuteOfDay(start, policy.timeZoneOffsetMinutes);
  const endMinute = startMinute + (end.getTime() - start.getTime()) / 60000;
  return policy.workingHours.some((rule) => rule.weekday === weekday && startMinute >= rule.startMinute && endMinute <= rule.endMinute);
}

// Раздел 7 ТЗ — "до трёх лучших вариантов"; ранжирование этапа 1 —
// простое "раньше — лучше" (жёсткие условия уже отфильтрованы выше:
// рабочие часы, буферы, минимальный срок, занятость). Более тонкое
// ранжирование по предпочтениям/крупным рабочим блокам — раздел 11 ТЗ,
// следующий заход.
export function findAvailableSlots(
  searchFrom: Date,
  searchTo: Date,
  durationMinutes: number,
  policy: AvailabilityPolicy,
  busy: BusyInterval[] | 'UNKNOWN',
  now: Date,
  maxResults = 3,
): SlotSearchResult {
  if (busy === 'UNKNOWN') return { status: 'UNKNOWN' };

  const bufferMs = policy.bufferMinutes * 60 * 1000;
  const durationMs = durationMinutes * 60 * 1000;
  const stepMs = policy.slotStepMinutes * 60 * 1000;
  const earliestStart = Math.max(searchFrom.getTime(), now.getTime() + policy.minNoticeHours * 60 * 60 * 1000);

  const slots: AvailableSlot[] = [];
  for (let t = Math.ceil(earliestStart / stepMs) * stepMs; t + durationMs <= searchTo.getTime(); t += stepMs) {
    const start = new Date(t);
    const end = new Date(t + durationMs);
    if (!fitsWorkingHours(start, end, policy)) continue;
    if (overlapsAnyBusy(start, end, busy, bufferMs)) continue;
    slots.push({ start, end });
    if (slots.length >= maxResults) break;
  }

  return { status: 'OK', slots };
}

// Раздел 11 ТЗ — редактируемые проектные значения по умолчанию "до
// настройки руководителем", не встроенные ограничения Google. Рабочие дни
// Пн-Пт 09:00-18:00 по Asia/Almaty (+05:00, без DST).
export function defaultAvailabilityPolicy(): AvailabilityPolicy {
  return {
    timeZoneOffsetMinutes: 5 * 60,
    workingHours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 18 * 60 })),
    bufferMinutes: 15,
    minNoticeHours: 4,
    slotStepMinutes: 15,
  };
}

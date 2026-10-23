import { buildTripTimeline, dayOffset, describeEntryTime, formatDayKey, formatUntil, formatZoneTime, groupTimelineByDay, locateNow, zoneDayKey, zoneLabel } from '../../../../packages/shared-types/src/trip-timeline';

// Программа поездки Алматы → Пекин (владелец 23.10.2026): время пунктов — по
// месту проведения, отметка «Вы сейчас здесь» — по реальному моменту.

const leg = (id: string, departAt: string | null, departTz: number | null, arriveAt: string | null, arriveTz: number | null) => ({
  id,
  departAt,
  departTimeZoneOffsetMinutes: departTz,
  arriveAt,
  arriveTimeZoneOffsetMinutes: arriveTz,
});
const event = (id: string, startAt: string | null, tz: number | null, endAt: string | null = null, dateOnly: string | null = null) => ({
  id,
  startAt,
  startTimeZoneOffsetMinutes: tz,
  endAt,
  dateOnly,
});
const stay = (id: string, checkInAt: string | null, checkOutAt: string | null) => ({ id, checkInAt, checkOutAt });

// 24.10: утром встреча в Алматы, перелёт в Пекин, вечером ужин в Пекине; 25.10 — переговоры.
const trip = {
  legs: [leg('l1', '2026-10-24T13:00:00+05:00', 300, '2026-10-24T21:30:00+08:00', 480)],
  events: [
    event('e1', '2026-10-24T09:00:00+05:00', 300, '2026-10-24T10:30:00+05:00'),
    event('e2', '2026-10-24T22:30:00+08:00', 480),
    event('e3', '2026-10-25T10:00:00+08:00', null, '2026-10-25T12:00:00+08:00'),
    event('e4', null, null, null, '2026-10-26'),
    event('e5', null, null),
  ],
  stays: [stay('s1', '2026-10-24T23:00:00+08:00', '2026-10-27T12:00:00+08:00')],
};
const at = (iso: string) => new Date(iso).getTime();

describe('buildTripTimeline', () => {
  const entries = buildTripTimeline(trip);

  it('хронология; только дата — в начало своего дня, без даты — в конце', () => {
    expect(entries.map((e) => e.key)).toEqual(['event-e1', 'leg-l1', 'event-e2', 'stay-s1', 'event-e3', 'event-e4', 'event-e5']);
  });

  it('пояс пункта без своего пояса — по месту, где руководитель в этот момент (после прилёта — Китай)', () => {
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey['stay-s1'].offset).toBe(480);
    expect(byKey['event-e3'].offset).toBe(480);
    expect(byKey['leg-l1'].offset).toBe(300);
    expect(byKey['leg-l1'].arriveOffset).toBe(480);
  });

  it('время показывается по месту, а не по поясу телефона', () => {
    const e2 = entries.find((e) => e.key === 'event-e2')!;
    expect(formatZoneTime(e2.start!, e2.offset)).toBe('22:30');
    expect(zoneDayKey(e2.start!, e2.offset)).toBe('2026-10-24');
    expect(zoneLabel(480)).toBe('Китай, UTC+8');
    expect(zoneLabel(300)).toBe('Казахстан, UTC+5');
    expect(zoneLabel(330)).toBe('UTC+5:30');
  });

  it('событие без окончания длится до следующего пункта (не дольше 3 ч)', () => {
    const e2 = entries.find((e) => e.key === 'event-e2')!;
    expect(e2.end).toBe(e2.start! + 3 * 3_600_000);
  });

  it('группировка по дням места', () => {
    const days = groupTimelineByDay(entries);
    expect(days.map((d) => [d.dayKey, d.entries.length])).toEqual([
      ['2026-10-24', 4],
      ['2026-10-25', 1],
      ['2026-10-26', 1],
      [null, 1],
    ]);
    expect(formatDayKey('2026-10-24')).toBe('Суббота, 24 октября');
  });
});

describe('locateNow', () => {
  const entries = buildTripTimeline(trip);

  it('идёт встреча — отметка на ней, следующее — перелёт', () => {
    expect(locateNow(entries, at('2026-10-24T09:30:00+05:00'))).toEqual({ currentKey: 'event-e1', nextKey: 'leg-l1', between: false, offset: 300 });
  });

  it('в полёте — текущий перелёт', () => {
    expect(locateNow(entries, at('2026-10-24T18:00:00+08:00'))?.currentKey).toBe('leg-l1');
  });

  it('пауза между пунктами — отметка «Сейчас» перед следующим, пояс — уже Китай после прилёта', () => {
    const now = locateNow(entries, at('2026-10-25T08:00:00+08:00'));
    expect(now).toEqual({ currentKey: 'stay-s1', nextKey: 'event-e3', between: true, offset: 480 });
  });

  it('до поездки больше суток и после — без отметки', () => {
    expect(locateNow(entries, at('2026-10-20T10:00:00+05:00'))).toBeNull();
    expect(locateNow(entries, at('2026-11-05T10:00:00+05:00'))).toBeNull();
  });

  it('за несколько часов до первого пункта — «Сейчас» перед ним', () => {
    expect(locateNow(entries, at('2026-10-24T07:00:00+05:00'))).toMatchObject({ currentKey: null, nextKey: 'event-e1', between: true });
  });

  it('пустая программа или без времени — null', () => {
    expect(locateNow(buildTripTimeline({ legs: [], events: [event('x', null, null)], stays: [] }), Date.now())).toBeNull();
  });
});

describe('formatUntil', () => {
  it('часы/минуты/дни', () => {
    const t = at('2026-10-24T10:00:00Z');
    expect(formatUntil(t, t + 5 * 60_000)).toBe('через 5 мин');
    expect(formatUntil(t, t + 80 * 60_000)).toBe('через 1 ч 20 мин');
    expect(formatUntil(t, t + 26 * 3_600_000)).toBe('через 1 дн 2 ч');
  });
});

describe('describeEntryTime', () => {
  const entries = buildTripTimeline(trip);
  const days = groupTimelineByDay(entries);
  const text = (key: string) => {
    const day = days.find((d) => d.entries.some((e) => e.key === key))!;
    return describeEntryTime(day.entries.find((e) => e.key === key)!, dayOffset(day));
  };

  it('пояс дня не повторяется, другой пояс — подписан', () => {
    expect(dayOffset(days[0])).toBe(300);
    expect(text('event-e1')).toBe('09:00–10:30');
    expect(text('leg-l1')).toBe('13:00 → 21:30 (Китай)');
    expect(text('event-e2')).toBe('22:30 (Китай)');
    expect(text('stay-s1')).toBe('заезд 23:00 (Китай) · выезд 27.10 12:00');
    expect(text('event-e3')).toBe('10:00–12:00');
    expect(text('event-e4')).toBe('время не подтверждено');
    expect(text('event-e5')).toBe('дата не подтверждена');
  });
});

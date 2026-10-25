import { buildSimpleCron, isValidCron, nextRunAfter, parseSimpleCron } from './routine-schedule';

// Время в тестах — UTC; Алматы = UTC+5.
const utc = (s: string) => new Date(`${s}Z`);

describe('расписание регламента', () => {
  it('простой вид ↔ cron', () => {
    expect(buildSimpleCron({ days: [1, 3, 5], time: '09:00' })).toBe('0 9 * * 1,3,5');
    expect(buildSimpleCron({ days: [7, 1], time: '18:30' })).toBe('30 18 * * 1,0');
    expect(buildSimpleCron({ days: [1, 2, 3, 4, 5, 6, 7], time: '07:05' })).toBe('5 7 * * *');
    expect(buildSimpleCron({ days: [], time: '09:00' })).toBeNull();
    expect(buildSimpleCron({ days: [1], time: '25:00' })).toBeNull();
    expect(parseSimpleCron('0 9 * * 1,3,5')).toEqual({ days: [1, 3, 5], time: '09:00' });
    expect(parseSimpleCron('30 18 * * 1,0')).toEqual({ days: [1, 7], time: '18:30' });
    expect(parseSimpleCron('5 7 * * *')).toEqual({ days: [1, 2, 3, 4, 5, 6, 7], time: '07:05' });
    expect(parseSimpleCron('*/15 * * * *')).toBeNull();
    expect(parseSimpleCron(null)).toBeNull();
  });

  it('проверка cron', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('*/10 8-18 1,15 * *')).toBe(true);
    expect(isValidCron('0 9 * *')).toBe(false);
    expect(isValidCron('60 9 * * *')).toBe(false);
    expect(isValidCron('0 9 * * 8')).toBe(false);
  });

  it('следующий запуск — по времени Алматы', () => {
    // Понедельник 26.10.2026, 03:00 UTC = 08:00 Алматы → в 09:00 Алматы = 04:00 UTC.
    expect(nextRunAfter('0 9 * * 1', utc('2026-10-26T03:00:00'))).toEqual(utc('2026-10-26T04:00:00'));
    // Ровно в момент слота — уже следующий (строго после).
    expect(nextRunAfter('0 9 * * 1', utc('2026-10-26T04:00:00'))).toEqual(utc('2026-11-02T04:00:00'));
    // Поздно вечером UTC — уже следующий местный день: вс 25.10 20:00 UTC = пн 26.10 01:00 Алматы.
    expect(nextRunAfter('30 0 * * *', utc('2026-10-25T20:00:00'))).toEqual(utc('2026-10-26T19:30:00'));
    expect(nextRunAfter('0 9 * * 0', utc('2026-10-26T03:00:00'))).toEqual(utc('2026-11-01T04:00:00'));
  });

  it('день месяца и день недели — как в cron (любое из двух)', () => {
    // 1-е число или пятница; 26.10.2026 — понедельник → пятница 30.10.
    expect(nextRunAfter('0 9 1 * 5', utc('2026-10-26T05:00:00'))).toEqual(utc('2026-10-30T04:00:00'));
    expect(nextRunAfter('0 9 31 2 *', utc('2026-10-26T05:00:00'))).toBeNull();
  });
});

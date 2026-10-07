import { defaultAvailabilityPolicy, findAvailableSlots } from './calendar-availability';

// Понедельник 2026-10-12 00:00 UTC+5 => 2026-10-11T19:00:00Z.
const MONDAY_MIDNIGHT_UTC = new Date('2026-10-11T19:00:00.000Z');
const policy = defaultAvailabilityPolicy(); // Пн-Пт 09:00-18:00, буфер 15м, минимум 4ч, шаг 15м

function at(hoursFromMondayMidnightLocal: number): Date {
  return new Date(MONDAY_MIDNIGHT_UTC.getTime() + hoursFromMondayMidnightLocal * 60 * 60 * 1000);
}

describe('findAvailableSlots (ТЗ разд. 11)', () => {
  const now = at(0); // понедельник 00:00 местного

  it('UNKNOWN источник занятости — не возвращает слоты вообще', () => {
    const result = findAvailableSlots(at(9), at(18), 30, policy, 'UNKNOWN', now);
    expect(result).toEqual({ status: 'UNKNOWN' });
  });

  it('пустая занятость — находит слоты в рабочие часы с учётом минимального срока', () => {
    const result = findAvailableSlots(at(0), at(24), 30, policy, [], now);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') throw new Error('unreachable');
    expect(result.slots.length).toBeGreaterThan(0);
    // minNoticeHours=4 — первый слот не раньше 04:00, но рабочие часы с 09:00.
    expect(result.slots[0].start.getTime()).toBeGreaterThanOrEqual(at(9).getTime());
  });

  it('не предлагает слот до начала рабочего дня', () => {
    const result = findAvailableSlots(at(0), at(9), 30, policy, [], now);
    expect(result).toEqual({ status: 'OK', slots: [] });
  });

  it('не предлагает слот, выходящий за конец рабочего дня', () => {
    // 17:45-18:15 не вмещается целиком в 09:00-18:00 — не предлагается.
    const result = findAvailableSlots(at(17.75), at(18.25), 30, policy, [], now);
    expect(result).toEqual({ status: 'OK', slots: [] });
  });

  it('пропускает выходные (субботу/воскресенье)', () => {
    // Субботний диапазон целиком вне рабочих дней политики по умолчанию.
    const saturdayStart = at(5 * 24); // пятница 00:00 + 5 суток = среда следующей недели... проверим явно рабочий день недели
    const result = findAvailableSlots(at(5 * 24 + 0), at(5 * 24 + 24), 30, policy, [], now);
    // at(5*24) = субота 00:00 локально (понедельник+5 дней = субота)
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') throw new Error('unreachable');
    expect(result.slots).toHaveLength(0);
    void saturdayStart;
  });

  it('учитывает занятость с буфером — слот впритык к занятому интервалу не предлагается', () => {
    // Занято 10:00-11:00; буфер 15 минут — 10:30-11:00 тоже недопустим.
    const busy = [{ start: at(10), end: at(11) }];
    const result = findAvailableSlots(at(10.5), at(11), 30, policy, busy, now);
    expect(result).toEqual({ status: 'OK', slots: [] });
  });

  it('предлагает слот сразу после занятого интервала + буфер', () => {
    const busy = [{ start: at(10), end: at(11) }];
    const result = findAvailableSlots(at(9), at(13), 30, policy, busy, now);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') throw new Error('unreachable');
    // Первый слот ДО занятости (09:00) должен появиться раньше слотов после.
    expect(result.slots[0].start.getTime()).toBe(at(9).getTime());
    expect(result.slots.some((s) => s.start.getTime() >= at(11.25).getTime())).toBe(true);
  });

  it('минимальный срок (minNoticeHours) отфильтровывает слишком близкие слоты', () => {
    // Сейчас 08:00 (все еще до рабочего дня), минимум 4ч — первый допустимый слот не раньше 12:00.
    const result = findAvailableSlots(at(0), at(24), 30, policy, [], at(8));
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') throw new Error('unreachable');
    expect(result.slots[0].start.getTime()).toBeGreaterThanOrEqual(at(12).getTime());
  });

  it('не превышает maxResults', () => {
    const result = findAvailableSlots(at(0), at(24), 15, policy, [], now, 3);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') throw new Error('unreachable');
    expect(result.slots.length).toBeLessThanOrEqual(3);
  });

  it('слоты отсортированы по возрастанию начала (раньше — лучше, раздел 7 ТЗ)', () => {
    const result = findAvailableSlots(at(0), at(24), 30, policy, [], now, 5);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') throw new Error('unreachable');
    const times = result.slots.map((s) => s.start.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

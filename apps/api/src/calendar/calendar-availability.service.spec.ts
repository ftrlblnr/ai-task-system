import { CalendarAvailabilityService } from './calendar-availability.service';
import { defaultAvailabilityPolicy } from './calendar-availability';

// Окно поиска — рабочий понедельник 09:00–18:00 Алматы в БУДУЩЕМ: сервис
// отсекает прошедшее время по new Date(), поэтому зашитая дата (было
// 2026-10-12) перестаёт давать слоты, как только наступает.
function nextMondayWindow(): [Date, Date] {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  d.setUTCHours(4, 0, 0, 0);
  return [d, new Date(d.getTime() + 9 * 3_600_000)];
}

describe('CalendarAvailabilityService (ТЗ разд. 11) — сборка политики + занятости', () => {
  it('UNAVAILABLE от freeBusy → UNKNOWN результат, не "свободно"', async () => {
    const policy = { getOrDefault: jest.fn().mockResolvedValue({ ...defaultAvailabilityPolicy(), version: null }) };
    const freeBusy = { queryBusy: jest.fn().mockResolvedValue({ status: 'UNAVAILABLE' }) };
    const service = new CalendarAvailabilityService(policy as never, freeBusy as never);

    const result = await service.findSlots('owner-1', ...nextMondayWindow(), 30);
    expect(result).toEqual({ status: 'UNKNOWN' });
  });

  it('OK от freeBusy с пустой занятостью — считает слоты', async () => {
    const policy = { getOrDefault: jest.fn().mockResolvedValue({ ...defaultAvailabilityPolicy(), version: null, minNoticeHours: 0 }) };
    const freeBusy = { queryBusy: jest.fn().mockResolvedValue({ status: 'OK', busy: [] }) };
    const service = new CalendarAvailabilityService(policy as never, freeBusy as never);

    const result = await service.findSlots('owner-1', ...nextMondayWindow(), 30);
    expect(result.status).toBe('OK');
    if (result.status === 'OK') expect(result.slots.length).toBeGreaterThan(0);
  });
});

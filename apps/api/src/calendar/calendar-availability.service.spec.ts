import { CalendarAvailabilityService } from './calendar-availability.service';
import { defaultAvailabilityPolicy } from './calendar-availability';

describe('CalendarAvailabilityService (ТЗ разд. 11) — сборка политики + занятости', () => {
  it('UNAVAILABLE от freeBusy → UNKNOWN результат, не "свободно"', async () => {
    const policy = { getOrDefault: jest.fn().mockResolvedValue({ ...defaultAvailabilityPolicy(), version: null }) };
    const freeBusy = { queryBusy: jest.fn().mockResolvedValue({ status: 'UNAVAILABLE' }) };
    const service = new CalendarAvailabilityService(policy as never, freeBusy as never);

    const result = await service.findSlots('owner-1', new Date('2026-10-12T04:00:00.000Z'), new Date('2026-10-12T13:00:00.000Z'), 30);
    expect(result).toEqual({ status: 'UNKNOWN' });
  });

  it('OK от freeBusy с пустой занятостью — считает слоты', async () => {
    const policy = { getOrDefault: jest.fn().mockResolvedValue({ ...defaultAvailabilityPolicy(), version: null, minNoticeHours: 0 }) };
    const freeBusy = { queryBusy: jest.fn().mockResolvedValue({ status: 'OK', busy: [] }) };
    const service = new CalendarAvailabilityService(policy as never, freeBusy as never);

    const result = await service.findSlots('owner-1', new Date('2026-10-12T04:00:00.000Z'), new Date('2026-10-12T13:00:00.000Z'), 30);
    expect(result.status).toBe('OK');
    if (result.status === 'OK') expect(result.slots.length).toBeGreaterThan(0);
  });
});

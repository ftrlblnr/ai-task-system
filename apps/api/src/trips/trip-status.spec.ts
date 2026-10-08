import { computeTripTimeStatus } from './trip-status';

const NOW = new Date('2026-11-15T12:00:00.000Z');

describe('computeTripTimeStatus', () => {
  it('cancelledAt задан — CANCELLED независимо от дат', () => {
    expect(
      computeTripTimeStatus({ cancelledAt: new Date('2026-11-01'), periodPrecision: 'EXACT', periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-05') }, NOW),
    ).toBe('CANCELLED');
  });

  it('periodPrecision=UNKNOWN — NO_CONFIRMED_DATES', () => {
    expect(computeTripTimeStatus({ cancelledAt: null, periodPrecision: 'UNKNOWN', periodStart: null, periodEnd: null }, NOW)).toBe('NO_CONFIRMED_DATES');
  });

  it('период в будущем — UPCOMING', () => {
    expect(
      computeTripTimeStatus({ cancelledAt: null, periodPrecision: 'EXACT', periodStart: new Date('2026-12-01'), periodEnd: new Date('2026-12-05') }, NOW),
    ).toBe('UPCOMING');
  });

  it('текущий момент внутри периода — ONGOING', () => {
    expect(
      computeTripTimeStatus({ cancelledAt: null, periodPrecision: 'EXACT', periodStart: new Date('2026-11-10'), periodEnd: new Date('2026-11-20') }, NOW),
    ).toBe('ONGOING');
  });

  it('период в прошлом — COMPLETED', () => {
    expect(
      computeTripTimeStatus({ cancelledAt: null, periodPrecision: 'APPROXIMATE', periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-10-05') }, NOW),
    ).toBe('COMPLETED');
  });

  it('только periodStart (нет periodEnd) — считается однодневной', () => {
    expect(computeTripTimeStatus({ cancelledAt: null, periodPrecision: 'EXACT', periodStart: NOW, periodEnd: null }, NOW)).toBe('ONGOING');
  });
});

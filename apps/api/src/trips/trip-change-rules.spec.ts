import { buildEntityChanges, buildTripFieldChanges, type ExistingTripSnapshot } from './trip-change-rules';
import type { ComposedTrip } from './trip-compose';

function composed(overrides: Partial<ComposedTrip> = {}): ComposedTrip {
  return {
    destinationHint: null,
    summaryHint: null,
    periodStart: null,
    periodEnd: null,
    periodPrecision: 'UNKNOWN',
    legs: [],
    events: [],
    stays: [],
    contacts: [],
    facts: [],
    issues: [],
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingTripSnapshot> = {}): ExistingTripSnapshot {
  return { periodStart: null, periodEnd: null, periodPrecision: 'UNKNOWN', purposeSummary: null, ...overrides };
}

describe('buildEntityChanges', () => {
  it('каждый leg/event/stay/contact становится отдельным предложением, не схлопывается', () => {
    const changes = buildEntityChanges(
      composed({
        legs: [{ mode: 'FLIGHT', fromLocation: 'ALA', toLocation: 'IST', departAt: null, departTimeZoneOffsetMinutes: null, arriveAt: null, arriveTimeZoneOffsetMinutes: null, carrier: null, referenceCode: null, bookingStatus: 'BOOKED', sourceMaterialId: 'm1' }],
        contacts: [{ name: 'Иван', role: 'OTHER', organization: null, email: null, phone: null, sourceMaterialId: 'm2' }],
      }),
    );
    expect(changes).toHaveLength(2);
    expect(changes[0].entityType).toBe('TRIP_LEG');
    expect(changes[1].entityType).toBe('TRIP_CONTACT');
  });

  it('пустой composed — пустой список предложений', () => {
    expect(buildEntityChanges(composed())).toEqual([]);
  });
});

describe('buildTripFieldChanges — период', () => {
  it('существующий период UNKNOWN, новый найден — предлагается', () => {
    const changes = buildTripFieldChanges(existing(), composed({ periodStart: new Date('2026-12-01'), periodEnd: new Date('2026-12-05'), periodPrecision: 'EXACT' }));
    expect(changes).toHaveLength(1);
    expect(changes[0].fieldKey).toBe('period');
  });

  it('новый период уже укладывается в существующий — не предлагается', () => {
    const changes = buildTripFieldChanges(
      existing({ periodStart: new Date('2026-12-01'), periodEnd: new Date('2026-12-10'), periodPrecision: 'EXACT' }),
      composed({ periodStart: new Date('2026-12-02'), periodEnd: new Date('2026-12-03'), periodPrecision: 'EXACT' }),
    );
    expect(changes).toHaveLength(0);
  });

  it('новый период расширяет существующий — предлагается', () => {
    const changes = buildTripFieldChanges(
      existing({ periodStart: new Date('2026-12-01'), periodEnd: new Date('2026-12-05'), periodPrecision: 'EXACT' }),
      composed({ periodStart: new Date('2026-12-01'), periodEnd: new Date('2026-12-10'), periodPrecision: 'EXACT' }),
    );
    expect(changes).toHaveLength(1);
  });

  it('composed без дат вообще — период не предлагается', () => {
    expect(buildTripFieldChanges(existing(), composed())).toEqual([]);
  });
});

describe('buildTripFieldChanges — purposeSummary', () => {
  it('существующий purposeSummary пуст, новый summaryHint найден — предлагается', () => {
    const changes = buildTripFieldChanges(existing(), composed({ summaryHint: 'Командировка в Стамбул' }));
    expect(changes.some((c) => c.fieldKey === 'purposeSummary')).toBe(true);
  });

  it('существующий purposeSummary уже заполнен — не перезаписывается предложением', () => {
    const changes = buildTripFieldChanges(existing({ purposeSummary: 'Уже есть описание' }), composed({ summaryHint: 'Другое описание' }));
    expect(changes.some((c) => c.fieldKey === 'purposeSummary')).toBe(false);
  });
});

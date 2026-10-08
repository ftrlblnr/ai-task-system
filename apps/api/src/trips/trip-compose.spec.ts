import { composeTripFromMaterials, type MaterialDraft } from './trip-compose';
import type { TripExtractionDraft } from './trip-extraction';

function draft(overrides: Partial<TripExtractionDraft> = {}): TripExtractionDraft {
  return {
    readable: true,
    summaryHint: null,
    destinationHint: null,
    legs: [],
    events: [],
    stays: [],
    contacts: [],
    facts: [],
    issues: [],
    ...overrides,
  };
}

function material(materialId: string, fileLabel: string, d: TripExtractionDraft): MaterialDraft {
  return { materialId, fileLabel, draft: d };
}

describe('composeTripFromMaterials', () => {
  it('без материалов — пустая сборка, UNKNOWN precision, нет дат', () => {
    const composed = composeTripFromMaterials([]);
    expect(composed.periodPrecision).toBe('UNKNOWN');
    expect(composed.periodStart).toBeNull();
    expect(composed.periodEnd).toBeNull();
    expect(composed.issues).toEqual(['Не удалось извлечь ни перелётов/переездов, ни программы, ни проживания ни из одного материала — карточка создана только с тем, что есть.']);
  });

  it('билет с departAt/arriveAt -> EXACT precision, период по датам перелёта, sourceMaterialId проставлен', () => {
    const composed = composeTripFromMaterials([
      material(
        'm1',
        'ticket.pdf',
        draft({
          legs: [
            {
              mode: 'FLIGHT',
              fromLocation: 'ALA',
              toLocation: 'IST',
              departAt: '2026-11-10T06:00:00.000Z',
              departTimeZoneOffsetMinutes: 300,
              arriveAt: '2026-11-10T09:00:00.000Z',
              arriveTimeZoneOffsetMinutes: 180,
              carrier: 'Air Astana',
              referenceCode: 'ABC123',
              bookingStatus: 'BOOKED',
            },
          ],
        }),
      ),
    ]);
    expect(composed.periodPrecision).toBe('EXACT');
    expect(composed.periodStart?.toISOString()).toBe('2026-11-10T06:00:00.000Z');
    expect(composed.legs).toHaveLength(1);
    expect(composed.legs[0].sourceMaterialId).toBe('m1');
    expect(composed.issues).toEqual([]);
  });

  it('только dateOnly в событии (без точного времени) -> APPROXIMATE, не EXACT', () => {
    const composed = composeTripFromMaterials([
      material(
        'm1',
        'invite.pdf',
        draft({ events: [{ title: 'Встреча', startAt: null, startTimeZoneOffsetMinutes: null, dateOnly: '2026-11-12', endAt: null, location: null, notes: null }] }),
      ),
    ]);
    expect(composed.periodPrecision).toBe('APPROXIMATE');
    expect(composed.periodStart?.toISOString().slice(0, 10)).toBe('2026-11-12');
  });

  it('issues из разных материалов помечаются именем файла и собираются вместе', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'scan1.jpg', draft({ issues: ['нечитаемый фрагмент'] })),
      material('m2', 'scan2.jpg', draft({ issues: ['противоречит дате на билете'] })),
    ]);
    expect(composed.issues).toContain('scan1.jpg: нечитаемый фрагмент');
    expect(composed.issues).toContain('scan2.jpg: противоречит дате на билете');
  });

  it('конфликтующие значения между материалами не схлопываются — оба leg остаются отдельно', () => {
    const legA = { mode: 'FLIGHT' as const, fromLocation: 'ALA', toLocation: 'IST', departAt: '2026-11-10T06:00:00.000Z', departTimeZoneOffsetMinutes: null, arriveAt: null, arriveTimeZoneOffsetMinutes: null, carrier: null, referenceCode: null, bookingStatus: 'BOOKED' as const };
    const legB = { ...legA, departAt: '2026-11-11T06:00:00.000Z', bookingStatus: 'PROPOSED' as const };
    const composed = composeTripFromMaterials([material('m1', 'a.pdf', draft({ legs: [legA] })), material('m2', 'b.pdf', draft({ legs: [legB] }))]);
    expect(composed.legs).toHaveLength(2);
    expect(composed.legs.map((l) => l.bookingStatus)).toEqual(['BOOKED', 'PROPOSED']);
  });

  it('первый непустой summaryHint/destinationHint побеждает, не перезаписывается', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'a.pdf', draft({ summaryHint: 'Командировка в Стамбул', destinationHint: 'Стамбул' })),
      material('m2', 'b.pdf', draft({ summaryHint: 'Другое', destinationHint: 'Другой город' })),
    ]);
    expect(composed.summaryHint).toBe('Командировка в Стамбул');
    expect(composed.destinationHint).toBe('Стамбул');
  });

  it('невалидная дата от модели не ломает подсчёт периода', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'a.pdf', draft({ legs: [{ mode: 'FLIGHT', fromLocation: null, toLocation: null, departAt: 'not-a-date', departTimeZoneOffsetMinutes: null, arriveAt: null, arriveTimeZoneOffsetMinutes: null, carrier: null, referenceCode: null, bookingStatus: 'UNCONFIRMED' }] })),
    ]);
    expect(composed.periodPrecision).toBe('UNKNOWN');
    expect(composed.periodStart).toBeNull();
  });
});

import { composeTripFromMaterials, extractUtcOffsetMinutes, isDateOnly, type MaterialDraft } from './trip-compose';
import type { TripExtractedLeg, TripExtractionDraft } from './trip-extraction';

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

describe('extractUtcOffsetMinutes', () => {
  it('null на null/пустую строку', () => {
    expect(extractUtcOffsetMinutes(null)).toBeNull();
  });
  it('Z -> 0', () => {
    expect(extractUtcOffsetMinutes('2026-12-01T06:00:00Z')).toBe(0);
  });
  it('+05:00 -> 300', () => {
    expect(extractUtcOffsetMinutes('2026-12-01T06:00:00+05:00')).toBe(300);
  });
  it('-03:30 -> -210', () => {
    expect(extractUtcOffsetMinutes('2026-12-01T06:00:00-03:30')).toBe(-210);
  });
  it('без смещения -> null (не 0, не угадываем UTC)', () => {
    expect(extractUtcOffsetMinutes('2026-12-01T06:00:00')).toBeNull();
  });
  it('дата без времени -> null', () => {
    expect(extractUtcOffsetMinutes('2026-12-01')).toBeNull();
  });
});

describe('isDateOnly', () => {
  it('ровно YYYY-MM-DD -> true', () => {
    expect(isDateOnly('2026-12-01')).toBe(true);
  });
  it('полный ISO-момент -> false', () => {
    expect(isDateOnly('2026-12-01T06:00:00Z')).toBe(false);
  });
});

describe('composeTripFromMaterials', () => {
  it('без материалов — пустая сборка, UNKNOWN precision, нет дат', () => {
    const composed = composeTripFromMaterials([]);
    expect(composed.periodPrecision).toBe('UNKNOWN');
    expect(composed.periodStart).toBeNull();
    expect(composed.periodEnd).toBeNull();
    expect(composed.issues).toEqual(['Не удалось извлечь ни перелётов/переездов, ни программы, ни проживания ни из одного материала — карточка создана только с тем, что есть.']);
  });

  it('билет с departAt/arriveAt (со смещением в строке) -> EXACT precision, TZ-offset разворачивается, sourceMaterialId проставлен', () => {
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
              departAt: '2026-11-10T06:00:00+05:00',
              arriveAt: '2026-11-10T09:00:00+03:00',
              bookingReference: 'Air Astana ABC123',
              bookingStatus: 'BOOKED',
            },
          ],
        }),
      ),
    ]);
    expect(composed.periodPrecision).toBe('EXACT');
    expect(composed.legs).toHaveLength(1);
    expect(composed.legs[0].sourceMaterialId).toBe('m1');
    expect(composed.legs[0].departTimeZoneOffsetMinutes).toBe(300);
    expect(composed.legs[0].arriveTimeZoneOffsetMinutes).toBe(180);
    expect(composed.legs[0].carrier).toBe('Air Astana ABC123');
    expect(composed.legs[0].referenceCode).toBeNull();
    expect(composed.issues).toEqual([]);
  });

  it('событие с датой "YYYY-MM-DD" (без времени) -> APPROXIMATE, попадает в dateOnly, не в startAt', () => {
    const composed = composeTripFromMaterials([material('m1', 'invite.pdf', draft({ events: [{ title: 'Встреча', startAt: '2026-11-12', endAt: null, location: null }] }))]);
    expect(composed.periodPrecision).toBe('APPROXIMATE');
    expect(composed.events[0].startAt).toBeNull();
    expect(composed.events[0].dateOnly).toBe('2026-11-12');
    expect(composed.periodStart?.toISOString().slice(0, 10)).toBe('2026-11-12');
  });

  it('событие с полным ISO-моментом -> EXACT, попадает в startAt, не в dateOnly', () => {
    const composed = composeTripFromMaterials([material('m1', 'invite.pdf', draft({ events: [{ title: 'Встреча', startAt: '2026-11-12T10:00:00Z', endAt: null, location: null }] }))]);
    expect(composed.periodPrecision).toBe('EXACT');
    expect(composed.events[0].startAt).toBe('2026-11-12T10:00:00Z');
    expect(composed.events[0].dateOnly).toBeNull();
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
    const legA = { mode: 'FLIGHT' as const, fromLocation: 'ALA', toLocation: 'IST', departAt: '2026-11-10T06:00:00.000Z', arriveAt: null, bookingReference: null, bookingStatus: 'BOOKED' as const };
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
      material('m1', 'a.pdf', draft({ legs: [{ mode: 'FLIGHT', fromLocation: null, toLocation: null, departAt: 'not-a-date', arriveAt: null, bookingReference: null, bookingStatus: 'UNCONFIRMED' }] })),
    ]);
    expect(composed.periodPrecision).toBe('UNKNOWN');
    expect(composed.periodStart).toBeNull();
  });

  it('проживание: address объединённый, name всегда null (раздел про урезанную схему)', () => {
    const composed = composeTripFromMaterials([material('m1', 'hotel.pdf', draft({ stays: [{ address: 'Hilton Istanbul, Istiklal Cad. 123', checkInAt: null, checkOutAt: null, bookingStatus: 'PROPOSED' }] }))]);
    expect(composed.stays[0].address).toBe('Hilton Istanbul, Istiklal Cad. 123');
    expect(composed.stays[0].name).toBeNull();
  });

  it('контакт: organization всегда null (раздел про урезанную схему)', () => {
    const composed = composeTripFromMaterials([material('m1', 'invite.pdf', draft({ contacts: [{ name: 'Иван Иванов', role: 'OTHER', email: 'ivan@example.com', phone: null }] }))]);
    expect(composed.contacts[0].organization).toBeNull();
    expect(composed.contacts[0].email).toBe('ivan@example.com');
  });
});

describe('composeTripFromMaterials — дедупликация одного рейса на несколько пассажиров (живой баг 08.10.2026)', () => {
  function ticketLeg(overrides: Partial<TripExtractedLeg> = {}): TripExtractedLeg {
    return {
      mode: 'FLIGHT' as const,
      fromLocation: 'ALA',
      toLocation: 'IST',
      departAt: '2026-12-01T06:00:00+05:00',
      arriveAt: '2026-12-01T09:00:00+03:00',
      bookingReference: null,
      bookingStatus: 'BOOKED' as const,
      ...overrides,
    };
  }

  it('три билета на один и тот же рейс (разные материалы, разные пассажиры) схлопываются в один leg', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'ticket-ivan.pdf', draft({ legs: [ticketLeg({ bookingReference: 'KC901, билет AAA111' })] })),
      material('m2', 'ticket-petr.pdf', draft({ legs: [ticketLeg({ bookingReference: 'KC901, билет BBB222' })] })),
      material('m3', 'ticket-anna.pdf', draft({ legs: [ticketLeg({ bookingReference: 'KC901, билет CCC333' })] })),
    ]);
    expect(composed.legs).toHaveLength(1);
  });

  it('один и тот же рейс, но маршрут назван по-разному в разных билетах (язык/формат) — всё равно схлопывается по времени вылета', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'ticket-en.pdf', draft({ legs: [ticketLeg({ fromLocation: 'Astana (Nursultan Nazarbayev)', toLocation: 'Almaty', arriveAt: '2026-12-01T09:00:00+03:00' })] })),
      material('m2', 'ticket-ru.pdf', draft({ legs: [ticketLeg({ fromLocation: 'Астана (NQZ), T2', toLocation: 'Алматы (ALA), T1', arriveAt: null })] })),
    ]);
    expect(composed.legs).toHaveLength(1);
    // Ключ — только время вылета, маршрут текстом ненадёжен между билетами
    // (живой случай 08.10.2026); первое непустое имя побеждает.
    expect(composed.legs[0].fromLocation).toBe('Astana (Nursultan Nazarbayev)');
    // arriveAt — null у второго билета не стирает уже известное значение первого.
    expect(composed.legs[0].arriveAt).toBe('2026-12-01T09:00:00+03:00');
  });

  it('рейсы с одинаковым временем вылета, но заданные как РАЗНЫЕ объекты верхнего уровня — риск принят (разный mode не схлопывается)', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'a.pdf', draft({ legs: [ticketLeg({ mode: 'FLIGHT' })] })),
      material('m2', 'b.pdf', draft({ legs: [ticketLeg({ mode: 'TRAIN' })] })),
    ]);
    expect(composed.legs).toHaveLength(2);
  });

  it('рейсы с разным временем вылета (настоящий конфликт между источниками) НЕ схлопываются', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'a.pdf', draft({ legs: [ticketLeg({ departAt: '2026-11-10T06:00:00.000Z' })] })),
      material('m2', 'b.pdf', draft({ legs: [ticketLeg({ departAt: '2026-11-11T06:00:00.000Z' })] })),
    ]);
    expect(composed.legs).toHaveLength(2);
  });

  it('при схлопывании статус бронирования берётся максимальный (BOOKED важнее PROPOSED)', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'a.pdf', draft({ legs: [ticketLeg({ bookingStatus: 'PROPOSED' })] })),
      material('m2', 'b.pdf', draft({ legs: [ticketLeg({ bookingStatus: 'BOOKED' })] })),
    ]);
    expect(composed.legs).toHaveLength(1);
    expect(composed.legs[0].bookingStatus).toBe('BOOKED');
  });

  it('одинаковые проживания (3 брони на один отель/даты) схлопываются', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'a.pdf', draft({ stays: [{ address: 'Hilton Istanbul', checkInAt: '2026-12-01', checkOutAt: '2026-12-05', bookingStatus: 'BOOKED' }] })),
      material('m2', 'b.pdf', draft({ stays: [{ address: 'Hilton Istanbul', checkInAt: '2026-12-01', checkOutAt: '2026-12-05', bookingStatus: 'BOOKED' }] })),
    ]);
    expect(composed.stays).toHaveLength(1);
  });

  it('один и тот же контакт по имени из разных материалов схлопывается, email/phone объединяются', () => {
    const composed = composeTripFromMaterials([
      material('m1', 'a.pdf', draft({ contacts: [{ name: 'Иван Иванов', role: 'OTHER', email: 'ivan@example.com', phone: null }] })),
      material('m2', 'b.pdf', draft({ contacts: [{ name: 'иван иванов', role: 'OTHER', email: null, phone: '+7...' }] })),
    ]);
    expect(composed.contacts).toHaveLength(1);
    expect(composed.contacts[0].email).toBe('ivan@example.com');
    expect(composed.contacts[0].phone).toBe('+7...');
  });
});

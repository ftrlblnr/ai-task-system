import { buildEntityChanges, buildTripFieldChanges, type ExistingEntities, type ExistingTripSnapshot } from './trip-change-rules';
import { describeProposedChange } from '../../../../packages/shared-types/src/trip-changes';
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

// 23.10.2026: в поездке перелёт из программы (без рейса, не подтверждён),
// потом приходит билет — должно быть уточнение той же записи, не второй перелёт.
describe('buildEntityChanges — сопоставление с уже записанным', () => {
  const programLeg = {
    id: 'leg1',
    mode: 'FLIGHT',
    fromLocation: 'Астана',
    toLocation: 'Пекин',
    departAt: new Date('2026-10-24T14:00:00+05:00'),
    departTimeZoneOffsetMinutes: 300,
    arriveAt: new Date('2026-10-24T22:15:00+08:00'),
    arriveTimeZoneOffsetMinutes: 480,
    carrier: null,
    referenceCode: null,
    bookingStatus: 'UNCONFIRMED',
  };
  const lunch = {
    id: 'ev1',
    title: 'Обеденный перерыв',
    startAt: new Date('2026-10-26T11:30:00+08:00'),
    startTimeZoneOffsetMinutes: 480,
    dateOnly: null,
    endAt: new Date('2026-10-26T13:00:00+08:00'),
    location: null,
    notes: 'Питание по программе',
  };
  const existingEntities = (overrides: Partial<ExistingEntities> = {}): ExistingEntities => ({ legs: [programLeg], events: [lunch], stays: [], contacts: [], ...overrides });
  const ticket = (overrides: Record<string, unknown> = {}) => ({
    mode: 'FLIGHT' as const,
    fromLocation: 'Astana (NQZ)',
    toLocation: 'Beijing (PKX)',
    departAt: '2026-10-24T14:35:00+05:00',
    departTimeZoneOffsetMinutes: 300,
    arriveAt: '2026-10-24T22:40:00+08:00',
    arriveTimeZoneOffsetMinutes: 480,
    carrier: 'Air Astana',
    referenceCode: 'KC897',
    bookingStatus: 'BOOKED' as const,
    sourceMaterialId: 'ticket',
    ...overrides,
  });

  it('билет к перелёту из программы — уточнение той же записи: время, рейс, статус; названия городов не перетираются', () => {
    const changes = buildEntityChanges(composed({ legs: [ticket()] }), existingEntities());
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ entityType: 'TRIP_LEG', entityId: 'leg1', materialId: 'ticket' });
    expect(changes[0].proposedValue).toEqual({
      departAt: '2026-10-24T14:35:00+05:00',
      departTimeZoneOffsetMinutes: 300,
      arriveAt: '2026-10-24T22:40:00+08:00',
      arriveTimeZoneOffsetMinutes: 480,
      carrier: 'Air Astana',
      referenceCode: 'KC897',
      bookingStatus: 'BOOKED',
    });
    expect(changes[0].previousValue).toMatchObject({ referenceCode: null, bookingStatus: 'UNCONFIRMED', departAt: '2026-10-24T09:00:00.000Z' });
  });

  it('то же самое ещё раз (повторная загрузка) — никаких предложений', () => {
    const changes = buildEntityChanges(
      composed({ legs: [ticket({ departAt: '2026-10-24T14:00:00+05:00', arriveAt: '2026-10-24T22:15:00+08:00', carrier: null, referenceCode: null, bookingStatus: 'UNCONFIRMED' })] }),
      existingEntities(),
    );
    expect(changes).toEqual([]);
  });

  it('рейс в другой день — новый перелёт', () => {
    const changes = buildEntityChanges(composed({ legs: [ticket({ departAt: '2026-10-31T23:30:00+08:00', arriveAt: null })] }), existingEntities());
    expect(changes).toHaveLength(1);
    expect(changes[0].entityId).toBeUndefined();
  });

  it('статус брони не понижается', () => {
    const changes = buildEntityChanges(composed({ legs: [ticket({ bookingStatus: 'UNCONFIRMED', carrier: null, referenceCode: null })] }), existingEntities({ legs: [{ ...programLeg, bookingStatus: 'BOOKED' }] }));
    expect((changes[0].proposedValue as Record<string, unknown>).bookingStatus).toBeUndefined();
  });

  it('повторная программа: то же событие в то же время — без дубля, переформулировка примечания не предлагается', () => {
    const event = { title: 'Обед', startAt: '2026-10-26T11:30:00+08:00', startTimeZoneOffsetMinutes: 480, dateOnly: null, endAt: '2026-10-26T13:00:00+08:00', location: null, notes: 'Обед по программе пребывания', sourceMaterialId: 'm2' };
    expect(buildEntityChanges(composed({ events: [event] }), existingEntities())).toEqual([]);
    const moved = buildEntityChanges(composed({ events: [{ ...event, endAt: '2026-10-26T13:30:00+08:00', location: 'Ресторан отеля' }] }), existingEntities());
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ entityId: 'ev1', proposedValue: { endAt: '2026-10-26T13:30:00+08:00', location: 'Ресторан отеля' } });
  });

  it('бронь гостиницы к проживанию из программы (заезд в тот же день) — уточнение', () => {
    const stay = { id: 'st1', name: null, address: null, checkInAt: new Date('2026-10-25T00:00:00+08:00'), checkOutAt: new Date('2026-10-31T12:00:00+08:00'), bookingStatus: 'UNCONFIRMED' };
    const changes = buildEntityChanges(
      composed({ stays: [{ name: 'Beijing Hotel', address: 'Chang An Ave 33', checkInAt: '2026-10-25T14:00:00+08:00', checkOutAt: '2026-10-31T12:00:00+08:00', bookingStatus: 'BOOKED', sourceMaterialId: 'b' }] }),
      existingEntities({ stays: [stay] }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ entityType: 'TRIP_STAY', entityId: 'st1', proposedValue: { checkInAt: '2026-10-25T14:00:00+08:00', name: 'Beijing Hotel', address: 'Chang An Ave 33', bookingStatus: 'BOOKED' } });
  });

  it('контакт с тем же именем — дополняется телефоном, не дублируется', () => {
    const changes = buildEntityChanges(
      composed({ contacts: [{ name: 'Ли Вэй', role: 'OTHER', organization: null, email: null, phone: '+86 138 0000 0000', sourceMaterialId: 'c' }] }),
      existingEntities({ contacts: [{ id: 'ct1', name: 'Ли Вэй', organization: 'BCEE', email: null, phone: null }] }),
    );
    expect(changes).toEqual([expect.objectContaining({ entityId: 'ct1', proposedValue: { phone: '+86 138 0000 0000' } })]);
  });

  it('два билета на один записанный рейс — уточняется один раз, второй становится новым только если не совпал', () => {
    const changes = buildEntityChanges(composed({ legs: [ticket(), ticket({ sourceMaterialId: 't2' })] }), existingEntities());
    expect(changes.map((c) => c.entityId ?? 'new')).toEqual(['leg1', 'new']);
  });

  it('описание для экрана: было → станет по месту', () => {
    const [change] = buildEntityChanges(composed({ legs: [ticket()] }), existingEntities());
    const view = describeProposedChange({ entityType: change.entityType, entityId: change.entityId ?? null, fieldKey: null, previousValue: change.previousValue, proposedValue: change.proposedValue, reason: change.reason ?? null });
    expect(view.isUpdate).toBe(true);
    expect(view.title).toBe('Уточнение уже записанного перелёта/переезда Астана → Пекин 24.10');
    expect(view.rows).toEqual([
      { label: 'Отправление', before: '24.10 14:00', after: '24.10 14:35' },
      { label: 'Прибытие', before: '24.10 22:15, Китай', after: '24.10 22:40, Китай' },
      { label: 'Перевозчик', before: null, after: 'Air Astana' },
      { label: 'Рейс / бронь', before: null, after: 'KC897' },
      { label: 'Статус', before: 'Подтверждения не найдено', after: 'Забронировано' },
    ]);
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

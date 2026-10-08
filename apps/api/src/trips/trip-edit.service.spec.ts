import { NotFoundException } from '@nestjs/common';
import { TripEditService } from './trip-edit.service';
import { TripRightsService } from './trip-rights.service';
import { FakeTripsPrisma } from './test-support/fake-trips-prisma';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

const ORGANIZER: AuthenticatedUser = { id: 'owner-1', email: 'o@x.com', role: 'OWNER', isProfileAdmin: false };
const VIEWER: AuthenticatedUser = { id: 'viewer-1', email: 'v@x.com', role: 'EMPLOYEE', isProfileAdmin: false };

async function setupTrip(prisma: FakeTripsPrisma) {
  const trip = await prisma.trip.create({ data: { humanCode: 'TR-2026-001', title: 'Поездка', organizerId: ORGANIZER.id } });
  await prisma.tripMember.create({ data: { tripId: trip.id, employeeId: ORGANIZER.id, accessRole: 'ORGANIZER' } });
  await prisma.tripMember.create({ data: { tripId: trip.id, employeeId: VIEWER.id, accessRole: 'VIEWER' } });
  return trip;
}

function service(prisma: FakeTripsPrisma) {
  return new TripEditService(prisma as never, new TripRightsService(prisma as never));
}

describe('TripEditService.updateTrip', () => {
  it('ORGANIZER может отредактировать title/purposeSummary, пишет TripRevision', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    const updated = await svc.updateTrip(ORGANIZER, trip.id, { title: 'Новое название', purposeSummary: 'Цель' });

    expect(updated.title).toBe('Новое название');
    expect(prisma.tripRevisions).toHaveLength(1);
    expect(prisma.tripRevisions[0].entityType).toBe('TRIP');
  });

  it('cancelledAt задаёт отмену поездки', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    const updated = await svc.updateTrip(ORGANIZER, trip.id, { cancelledAt: '2026-11-01T00:00:00.000Z' });

    expect(updated.cancelledAt).not.toBeNull();
    expect(prisma.tripRevisions[0].summary).toContain('отменена');
  });

  it('VIEWER не может редактировать (нет права edit) — NotFoundException', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    await expect(svc.updateTrip(VIEWER, trip.id, { title: 'X' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TripEditService — перелёты/события/проживания/контакты', () => {
  it('updateLeg правит существующий перелёт, принадлежащий поездке', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const leg = await prisma.tripLeg.create({
      data: { tripId: trip.id, mode: 'FLIGHT', fromLocation: 'ALA', toLocation: 'IST', departAt: null, departTimeZoneOffsetMinutes: null, arriveAt: null, arriveTimeZoneOffsetMinutes: null, carrier: null, referenceCode: null, bookingStatus: 'UNCONFIRMED', sourceMaterialId: null },
    });
    const svc = service(prisma);

    const updated = await svc.updateLeg(ORGANIZER, trip.id, leg.id, { bookingStatus: 'BOOKED' });

    expect(updated.bookingStatus).toBe('BOOKED');
    expect(prisma.tripRevisions).toHaveLength(1);
  });

  it('updateLeg на перелёт другой поездки — NotFoundException', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const otherTrip = await prisma.trip.create({ data: { humanCode: 'TR-2026-002', title: 'Другая', organizerId: ORGANIZER.id } });
    const leg = await prisma.tripLeg.create({
      data: { tripId: otherTrip.id, mode: 'FLIGHT', fromLocation: null, toLocation: null, departAt: null, departTimeZoneOffsetMinutes: null, arriveAt: null, arriveTimeZoneOffsetMinutes: null, carrier: null, referenceCode: null, bookingStatus: 'UNCONFIRMED', sourceMaterialId: null },
    });
    const svc = service(prisma);

    await expect(svc.updateLeg(ORGANIZER, trip.id, leg.id, { bookingStatus: 'BOOKED' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleteEvent удаляет событие и пишет историю', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const event = await prisma.tripEvent.create({
      data: { tripId: trip.id, title: 'Встреча', startAt: null, startTimeZoneOffsetMinutes: null, dateOnly: null, endAt: null, location: null, notes: null, sourceMaterialId: null },
    });
    const svc = service(prisma);

    await svc.deleteEvent(ORGANIZER, trip.id, event.id);

    expect(prisma.tripEvents).toHaveLength(0);
    expect(prisma.tripRevisions[0].summary).toContain('удалено');
  });

  it('updateContact правит контакт', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const contact = await prisma.tripContact.create({ data: { tripId: trip.id, name: 'Иван', role: 'OTHER', organization: null, email: null, phone: null, sourceMaterialId: null } });
    const svc = service(prisma);

    const updated = await svc.updateContact(ORGANIZER, trip.id, contact.id, { phone: '+7...' });

    expect(updated.phone).toBe('+7...');
  });

  it('deleteStay на несуществующую запись — NotFoundException', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    await expect(svc.deleteStay(ORGANIZER, trip.id, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TripEditService — полный CRUD: ручное создание', () => {
  it('createLeg добавляет перелёт без sourceMaterialId, пишет TripRevision', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    const created = await svc.createLeg(ORGANIZER, trip.id, { mode: 'FLIGHT', fromLocation: 'ALA', toLocation: 'IST', bookingStatus: 'UNCONFIRMED' });

    expect(created.sourceMaterialId).toBeNull();
    expect(prisma.tripLegs).toHaveLength(1);
    expect(prisma.tripRevisions[0].summary).toContain('добавлен вручную');
  });

  it('createEvent добавляет событие', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    const created = await svc.createEvent(ORGANIZER, trip.id, { title: 'Переговоры' });

    expect(created.title).toBe('Переговоры');
    expect(prisma.tripEvents).toHaveLength(1);
  });

  it('createStay добавляет проживание', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    const created = await svc.createStay(ORGANIZER, trip.id, { name: 'Hilton', bookingStatus: 'PROPOSED' });

    expect(created.name).toBe('Hilton');
    expect(prisma.tripStays).toHaveLength(1);
  });

  it('createContact добавляет контакт', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    const created = await svc.createContact(ORGANIZER, trip.id, { name: 'Иван Иванов', role: 'OTHER' });

    expect(created.name).toBe('Иван Иванов');
    expect(prisma.tripContacts).toHaveLength(1);
  });

  it('VIEWER не может создавать (нет edit) — NotFoundException', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    await expect(svc.createLeg(VIEWER, trip.id, { mode: 'FLIGHT', bookingStatus: 'UNCONFIRMED' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TripEditService — полный CRUD: ExtractedFact', () => {
  it('createFact создаёт факт со статусом CONFIRMED (ручной ввод, не извлечение)', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    const created = await svc.createFact(ORGANIZER, trip.id, { factKey: 'виза', factValue: 'нужна' });

    expect(created.status).toBe('CONFIRMED');
    expect(created.materialId).toBeNull();
    expect(prisma.tripRevisions).toHaveLength(1);
  });

  it('updateFact правит значение факта', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const fact = await prisma.extractedFact.create({ data: { tripId: trip.id, factKey: 'виза', factValue: 'нужна' } });
    const svc = service(prisma);

    const updated = await svc.updateFact(ORGANIZER, trip.id, fact.id, { factValue: 'не нужна' });

    expect(updated.factValue).toBe('не нужна');
  });

  it('deleteFact удаляет факт', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const fact = await prisma.extractedFact.create({ data: { tripId: trip.id, factKey: 'виза', factValue: 'нужна' } });
    const svc = service(prisma);

    await svc.deleteFact(ORGANIZER, trip.id, fact.id);

    expect(prisma.extractedFacts).toHaveLength(0);
  });

  it('updateFact на факт другой поездки — NotFoundException', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const otherTrip = await prisma.trip.create({ data: { humanCode: 'TR-2026-999', title: 'Другая', organizerId: ORGANIZER.id } });
    const fact = await prisma.extractedFact.create({ data: { tripId: otherTrip.id, factKey: 'x', factValue: 'y' } });
    const svc = service(prisma);

    await expect(svc.updateFact(ORGANIZER, trip.id, fact.id, { factValue: 'z' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

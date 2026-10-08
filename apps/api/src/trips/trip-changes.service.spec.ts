import { ConflictException, NotFoundException } from '@nestjs/common';
import { TripChangesService } from './trip-changes.service';
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

describe('TripChangesService', () => {
  it('approve новой записи TRIP_LEG создаёт TripLeg и TripRevision', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripChangesService(prisma as never, new TripRightsService(prisma as never));
    const trip = await setupTrip(prisma);
    const change = await prisma.proposedChange.create({
      data: { tripId: trip.id, entityType: 'TRIP_LEG', proposedValue: { mode: 'FLIGHT', fromLocation: 'ALA', toLocation: 'IST', departAt: null, departTimeZoneOffsetMinutes: null, arriveAt: null, arriveTimeZoneOffsetMinutes: null, carrier: null, referenceCode: null, bookingStatus: 'BOOKED', sourceMaterialId: null } },
    });

    await service.approve(ORGANIZER, trip.id, change.id);

    expect(prisma.tripLegs).toHaveLength(1);
    expect(prisma.proposedChanges[0].status).toBe('APPLIED');
    expect(prisma.tripRevisions).toHaveLength(1);
    expect(prisma.tripRevisions[0].changeId).toBe(change.id);
  });

  it('approve полевого изменения TRIP (period) обновляет Trip', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripChangesService(prisma as never, new TripRightsService(prisma as never));
    const trip = await setupTrip(prisma);
    const change = await prisma.proposedChange.create({
      data: {
        tripId: trip.id,
        entityType: 'TRIP',
        fieldKey: 'period',
        previousValue: { periodStart: null, periodEnd: null, periodPrecision: 'UNKNOWN' },
        proposedValue: { periodStart: '2026-12-01T00:00:00.000Z', periodEnd: '2026-12-05T00:00:00.000Z', periodPrecision: 'EXACT' },
      },
    });

    await service.approve(ORGANIZER, trip.id, change.id);

    const updated = prisma.trips.find((t) => t.id === trip.id)!;
    expect(updated.periodPrecision).toBe('EXACT');
    expect(updated.periodStart?.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('reject помечает REJECTED, ничего не создаёт', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripChangesService(prisma as never, new TripRightsService(prisma as never));
    const trip = await setupTrip(prisma);
    const change = await prisma.proposedChange.create({
      data: { tripId: trip.id, entityType: 'TRIP_CONTACT', proposedValue: { name: 'Иван', role: 'OTHER', organization: null, email: null, phone: null, sourceMaterialId: null } },
    });

    await service.reject(ORGANIZER, trip.id, change.id);

    expect(prisma.tripContacts).toHaveLength(0);
    expect(prisma.proposedChanges[0].status).toBe('REJECTED');
    expect(prisma.tripRevisions).toHaveLength(0);
  });

  it('повторное подтверждение уже обработанного предложения — ConflictException', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripChangesService(prisma as never, new TripRightsService(prisma as never));
    const trip = await setupTrip(prisma);
    const change = await prisma.proposedChange.create({
      data: { tripId: trip.id, entityType: 'TRIP_CONTACT', proposedValue: { name: 'Иван', role: 'OTHER', organization: null, email: null, phone: null, sourceMaterialId: null } },
    });
    await service.reject(ORGANIZER, trip.id, change.id);

    await expect(service.approve(ORGANIZER, trip.id, change.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('VIEWER не может approve (нет права approve) — NotFoundException', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripChangesService(prisma as never, new TripRightsService(prisma as never));
    const trip = await setupTrip(prisma);
    const change = await prisma.proposedChange.create({
      data: { tripId: trip.id, entityType: 'TRIP_CONTACT', proposedValue: { name: 'Иван', role: 'OTHER', organization: null, email: null, phone: null, sourceMaterialId: null } },
    });

    await expect(service.approve(VIEWER, trip.id, change.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('approveAll применяет все PENDING разом', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripChangesService(prisma as never, new TripRightsService(prisma as never));
    const trip = await setupTrip(prisma);
    await prisma.proposedChange.create({ data: { tripId: trip.id, entityType: 'TRIP_CONTACT', proposedValue: { name: 'A', role: 'OTHER', organization: null, email: null, phone: null, sourceMaterialId: null } } });
    await prisma.proposedChange.create({ data: { tripId: trip.id, entityType: 'TRIP_CONTACT', proposedValue: { name: 'B', role: 'OTHER', organization: null, email: null, phone: null, sourceMaterialId: null } } });

    const result = await service.approveAll(ORGANIZER, trip.id);

    expect(result.approved).toBe(2);
    expect(prisma.tripContacts).toHaveLength(2);
    expect(prisma.proposedChanges.every((c) => c.status === 'APPLIED')).toBe(true);
  });
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TripMembersService } from './trip-members.service';
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
  return new TripMembersService(prisma as never, new TripRightsService(prisma as never));
}

describe('TripMembersService', () => {
  it('ORGANIZER может добавить нового участника (EDITOR)', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    const member = await svc.addOrUpdateMember(ORGANIZER, trip.id, { employeeId: 'delegate-1', accessRole: 'EDITOR' });

    expect(member.accessRole).toBe('EDITOR');
    expect(prisma.tripMembers).toHaveLength(3);
  });

  it('повторный вызов на того же сотрудника обновляет роль, не дублирует', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    await svc.addOrUpdateMember(ORGANIZER, trip.id, { employeeId: 'delegate-1', accessRole: 'VIEWER' });
    await svc.addOrUpdateMember(ORGANIZER, trip.id, { employeeId: 'delegate-1', accessRole: 'EDITOR' });

    const delegateRows = prisma.tripMembers.filter((m) => m.employeeId === 'delegate-1');
    expect(delegateRows).toHaveLength(1);
    expect(delegateRows[0].accessRole).toBe('EDITOR');
  });

  it('VIEWER не может добавлять участников (нет manage_access) — NotFoundException', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    await expect(svc.addOrUpdateMember(VIEWER, trip.id, { employeeId: 'delegate-1', accessRole: 'VIEWER' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('удалить обычного участника — ок', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    await svc.removeMember(ORGANIZER, trip.id, VIEWER.id);

    expect(prisma.tripMembers.find((m) => m.employeeId === VIEWER.id)).toBeUndefined();
  });

  it('удалить последнего ORGANIZER — BadRequestException', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    await expect(svc.removeMember(ORGANIZER, trip.id, ORGANIZER.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('удалить одного из ДВУХ ORGANIZER — разрешено', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    await prisma.tripMember.create({ data: { tripId: trip.id, employeeId: 'second-organizer', accessRole: 'ORGANIZER' } });
    const svc = service(prisma);

    await svc.removeMember(ORGANIZER, trip.id, ORGANIZER.id);

    expect(prisma.tripMembers.find((m) => m.employeeId === ORGANIZER.id)).toBeUndefined();
  });

  it('удалить несуществующего участника — NotFoundException', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const svc = service(prisma);

    await expect(svc.removeMember(ORGANIZER, trip.id, 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });
});

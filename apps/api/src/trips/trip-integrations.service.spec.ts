import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TripIntegrationsService } from './trip-integrations.service';
import { TripRightsService } from './trip-rights.service';
import { FakeTripsPrisma } from './test-support/fake-trips-prisma';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

const OWNER: AuthenticatedUser = { id: 'owner-1', email: 'o@x.com', role: 'OWNER', isProfileAdmin: false };
const EMPLOYEE_MEMBER: AuthenticatedUser = { id: 'emp-1', email: 'e@x.com', role: 'EMPLOYEE', isProfileAdmin: false };

async function setupTrip(prisma: FakeTripsPrisma) {
  const trip = await prisma.trip.create({ data: { humanCode: 'TR-2026-001', title: 'Поездка', organizerId: OWNER.id } });
  await prisma.tripMember.create({ data: { tripId: trip.id, employeeId: OWNER.id, accessRole: 'ORGANIZER' } });
  await prisma.tripMember.create({ data: { tripId: trip.id, employeeId: EMPLOYEE_MEMBER.id, accessRole: 'EDITOR' } });
  return trip;
}

function fakeEvents() {
  return { create: jest.fn().mockResolvedValue({ id: 'event-1' }) };
}
function fakeTasks() {
  return { create: jest.fn().mockResolvedValue({ id: 'task-1' }) };
}

describe('TripIntegrationsService.addEventToCalendar', () => {
  it('OWNER с точным временем — создаёт событие в календаре и TripRevision', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const event = await prisma.tripEvent.create({
      data: { tripId: trip.id, title: 'Встреча', startAt: new Date('2026-12-01T10:00:00.000Z'), startTimeZoneOffsetMinutes: null, dateOnly: null, endAt: new Date('2026-12-01T11:00:00.000Z'), location: null, notes: null, sourceMaterialId: null },
    });
    const events = fakeEvents();
    const service = new TripIntegrationsService(prisma as never, new TripRightsService(prisma as never), events as never, fakeTasks() as never);

    const result = await service.addEventToCalendar(OWNER, trip.id, event.id);

    expect(result).toEqual({ id: 'event-1' });
    expect(events.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Встреча' }), OWNER.id);
    expect(prisma.tripRevisions).toHaveLength(1);
  });

  it('не-OWNER участник — ForbiddenException (личный календарь только у руководителя)', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const event = await prisma.tripEvent.create({
      data: { tripId: trip.id, title: 'Встреча', startAt: new Date(), startTimeZoneOffsetMinutes: null, dateOnly: null, endAt: new Date(), location: null, notes: null, sourceMaterialId: null },
    });
    const service = new TripIntegrationsService(prisma as never, new TripRightsService(prisma as never), fakeEvents() as never, fakeTasks() as never);

    await expect(service.addEventToCalendar(EMPLOYEE_MEMBER, trip.id, event.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('событие без точного startAt/endAt — BadRequestException, в календарь ничего не уходит', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const event = await prisma.tripEvent.create({
      data: { tripId: trip.id, title: 'Без времени', startAt: null, startTimeZoneOffsetMinutes: null, dateOnly: new Date('2026-12-01'), endAt: null, location: null, notes: null, sourceMaterialId: null },
    });
    const events = fakeEvents();
    const service = new TripIntegrationsService(prisma as never, new TripRightsService(prisma as never), events as never, fakeTasks() as never);

    await expect(service.addEventToCalendar(OWNER, trip.id, event.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(events.create).not.toHaveBeenCalled();
  });

  it('событие из другой поездки — NotFoundException', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const otherTrip = await prisma.trip.create({ data: { humanCode: 'TR-2026-002', title: 'Другая', organizerId: OWNER.id } });
    const event = await prisma.tripEvent.create({
      data: { tripId: otherTrip.id, title: 'Чужое', startAt: new Date(), startTimeZoneOffsetMinutes: null, dateOnly: null, endAt: new Date(), location: null, notes: null, sourceMaterialId: null },
    });
    const service = new TripIntegrationsService(prisma as never, new TripRightsService(prisma as never), fakeEvents() as never, fakeTasks() as never);

    await expect(service.addEventToCalendar(OWNER, trip.id, event.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TripIntegrationsService.proposeTask', () => {
  it('EDITOR с явным assignee+deadline — создаёт задачу и TripRevision', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    const tasks = fakeTasks();
    const service = new TripIntegrationsService(prisma as never, new TripRightsService(prisma as never), fakeEvents() as never, tasks as never);

    const result = await service.proposeTask(EMPLOYEE_MEMBER, trip.id, { title: 'Получить визу', assigneeId: 'someone', dueDate: '2026-11-20' });

    expect(result).toEqual({ id: 'task-1' });
    expect(tasks.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Получить визу', assigneeId: 'someone', dueDate: '2026-11-20' }), EMPLOYEE_MEMBER);
    expect(prisma.tripRevisions).toHaveLength(1);
  });

  it('VIEWER без edit — NotFoundException, задача не создаётся', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupTrip(prisma);
    await prisma.tripMember.create({ data: { tripId: trip.id, employeeId: 'viewer-x', accessRole: 'VIEWER' } });
    const tasks = fakeTasks();
    const service = new TripIntegrationsService(prisma as never, new TripRightsService(prisma as never), fakeEvents() as never, tasks as never);

    await expect(
      service.proposeTask({ id: 'viewer-x', email: 'x@x.com', role: 'EMPLOYEE', isProfileAdmin: false }, trip.id, { title: 'X', assigneeId: 'a', dueDate: '2026-11-20' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tasks.create).not.toHaveBeenCalled();
  });
});

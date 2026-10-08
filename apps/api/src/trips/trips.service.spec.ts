import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TripsService, computeBatchContentHash, type MaterialUpload } from './trips.service';
import { FakeTripsPrisma } from './test-support/fake-trips-prisma';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

const USER: AuthenticatedUser = { id: 'owner-1', email: 'owner@x.com', role: 'OWNER', isProfileAdmin: false };

function material(content: string, name = 'ticket.pdf', mimeType = 'application/pdf'): MaterialUpload {
  return { buffer: Buffer.from(content), originalName: name, mimeType };
}

function fakeFilesService() {
  let counter = 0;
  return {
    upload: jest.fn((_user: unknown, buffer: Buffer, originalName: string, mimeType: string) => ({
      id: `file-${++counter}`,
      employeeId: USER.id,
      name: originalName,
      mimeType,
      size: buffer.length,
      storageProvider: 'local',
      storageKey: `key-${counter}`,
      source: 'UPLOADED',
      conversationId: null,
      messageId: null,
      createdAt: new Date(),
      expiresAt: null,
    })),
  };
}

function fakeRights(overrides: { canCreate?: boolean; permission?: 'ALLOW' | 'DENY' } = {}) {
  return {
    assertCanCreateTrips: jest.fn(() => {
      if (overrides.canCreate === false) throw new Error('forbidden');
    }),
    assertPermission: jest.fn(() => {
      if (overrides.permission === 'DENY') throw new NotFoundException('Поездка не найдена');
      return 'ORGANIZER';
    }),
    getMembership: jest.fn(),
  };
}

describe('computeBatchContentHash', () => {
  it('детерминирован и не зависит от порядка файлов в пакете', () => {
    const a = material('AAA', 'a.pdf');
    const b = material('BBB', 'b.pdf');
    expect(computeBatchContentHash([a, b])).toBe(computeBatchContentHash([b, a]));
  });

  it('меняется при изменении содержимого файла', () => {
    expect(computeBatchContentHash([material('AAA')])).not.toBe(computeBatchContentHash([material('BBB')]));
  });

  it('тот же набор файлов с разным scope (новая/существующая поездка) — разный хэш', () => {
    const files = [material('AAA')];
    expect(computeBatchContentHash(files, 'NEW')).not.toBe(computeBatchContentHash(files, 'trip-123'));
  });
});

describe('TripsService.createRun', () => {
  it('без материалов — BadRequestException', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    await expect(service.createRun(USER, [])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('больше MAX_MATERIALS_PER_RUN — BadRequestException', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    const materials = Array.from({ length: 11 }, (_, i) => material(`content-${i}`, `f${i}.pdf`));
    await expect(service.createRun(USER, materials)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('создаёт AgentRun с материалами, статус RECEIVED', async () => {
    const prisma = new FakeTripsPrisma();
    const files = fakeFilesService();
    const service = new TripsService(prisma as never, files as never, fakeRights() as never);
    const run = await service.createRun(USER, [material('AAA', 'ticket.pdf'), material('BBB', 'invite.pdf')]);
    expect(run.status).toBe('RECEIVED');
    expect(run.materials).toHaveLength(2);
    expect(files.upload).toHaveBeenCalledTimes(2);
  });

  it('повторная отправка того же пакета (тот же набор файлов) не создаёт второй AgentRun', async () => {
    const prisma = new FakeTripsPrisma();
    const files = fakeFilesService();
    const service = new TripsService(prisma as never, files as never, fakeRights() as never);
    const materials = [material('AAA', 'ticket.pdf'), material('BBB', 'invite.pdf')];
    const first = await service.createRun(USER, materials);
    const second = await service.createRun(USER, materials);
    expect(second.id).toBe(first.id);
    expect(prisma.agentRuns).toHaveLength(1);
    // Второй вызов не должен был заново грузить файлы — идемпотентность
    // проверяется ДО upload(), не после.
    expect(files.upload).toHaveBeenCalledTimes(2);
  });

  it('тот же пакет файлов в другом порядке — всё равно дедуплицируется', async () => {
    const prisma = new FakeTripsPrisma();
    const files = fakeFilesService();
    const service = new TripsService(prisma as never, files as never, fakeRights() as never);
    const first = await service.createRun(USER, [material('AAA', 'a.pdf'), material('BBB', 'b.pdf')]);
    const second = await service.createRun(USER, [material('BBB', 'b.pdf'), material('AAA', 'a.pdf')]);
    expect(second.id).toBe(first.id);
    expect(prisma.agentRuns).toHaveLength(1);
  });

  it('без права trips.create — исключение из rights прокидывается наверх', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights({ canCreate: false }) as never);
    await expect(service.createRun(USER, [material('AAA')])).rejects.toThrow('forbidden');
  });
});

describe('TripsService.addMaterialsToTrip', () => {
  it('создаёт AgentRun с tripId, заданным с самого начала', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    const run = await service.addMaterialsToTrip(USER, 'trip-1', [material('AAA')]);
    expect(run.tripId).toBe('trip-1');
  });

  it('те же файлы, отправленные в ДВЕ разные поездки — два разных AgentRun, не дедуплицируются', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    const materials = [material('AAA')];
    const runA = await service.addMaterialsToTrip(USER, 'trip-a', materials);
    const runB = await service.addMaterialsToTrip(USER, 'trip-b', materials);
    expect(runA.id).not.toBe(runB.id);
    expect(prisma.agentRuns).toHaveLength(2);
  });

  it('повтор того же пакета в ту же поездку — дедуплицируется (не создаёт второй AgentRun)', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    const materials = [material('AAA')];
    const first = await service.addMaterialsToTrip(USER, 'trip-1', materials);
    const second = await service.addMaterialsToTrip(USER, 'trip-1', materials);
    expect(second.id).toBe(first.id);
    expect(prisma.agentRuns).toHaveLength(1);
  });

  it('без права materials.add (DENY) — исключение прокидывается, файлы не загружаются', async () => {
    const prisma = new FakeTripsPrisma();
    const files = fakeFilesService();
    const service = new TripsService(prisma as never, files as never, fakeRights({ permission: 'DENY' }) as never);
    await expect(service.addMaterialsToTrip(USER, 'trip-1', [material('AAA')])).rejects.toBeInstanceOf(NotFoundException);
    expect(files.upload).not.toHaveBeenCalled();
  });
});

describe('TripsService.getRun', () => {
  it('чужой initiatorId — NotFoundException (404, не 403)', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    const run = await service.createRun(USER, [material('AAA')]);
    await expect(service.getRun({ ...USER, id: 'other' }, run.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('свой run — возвращается с материалами', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    const run = await service.createRun(USER, [material('AAA')]);
    const fetched = await service.getRun(USER, run.id);
    expect(fetched.id).toBe(run.id);
  });
});

describe('TripsService.listTrips / getTrip', () => {
  it('listTrips — только поездки, где есть TripMember для этого сотрудника', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    await prisma.trip.create({ data: { humanCode: 'TR-2026-001', title: 'Поездка A', organizerId: USER.id } });
    const tripB = await prisma.trip.create({ data: { humanCode: 'TR-2026-002', title: 'Поездка B', organizerId: 'other' } });
    await prisma.tripMember.create({ data: { tripId: tripB.id, employeeId: USER.id, accessRole: 'VIEWER' } });

    const trips = await service.listTrips(USER);
    expect(trips).toHaveLength(1);
    expect(trips[0].id).toBe(tripB.id);
    expect(trips[0].timeStatus).toBe('NO_CONFIRMED_DATES');
  });

  it('listTrips — пусто, если нет членства ни в одной поездке', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    await prisma.trip.create({ data: { humanCode: 'TR-2026-001', title: 'Чужая поездка', organizerId: 'other' } });
    expect(await service.listTrips(USER)).toEqual([]);
  });

  it('getTrip — без прав (assertPermission бросает) — исключение прокидывается, trip не читается', async () => {
    const prisma = new FakeTripsPrisma();
    const rights = fakeRights({ permission: 'DENY' });
    const service = new TripsService(prisma as never, fakeFilesService() as never, rights as never);
    await expect(service.getTrip(USER, 'missing-trip')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getTrip — возвращает вложенные legs/events/stays/contacts/materials/facts/members и timeStatus', async () => {
    const prisma = new FakeTripsPrisma();
    const service = new TripsService(prisma as never, fakeFilesService() as never, fakeRights() as never);
    const trip = await prisma.trip.create({ data: { humanCode: 'TR-2026-003', title: 'Поездка', organizerId: USER.id } });
    await prisma.tripLeg.create({
      data: {
        tripId: trip.id,
        mode: 'FLIGHT',
        fromLocation: 'ALA',
        toLocation: 'IST',
        departAt: null,
        departTimeZoneOffsetMinutes: null,
        arriveAt: null,
        arriveTimeZoneOffsetMinutes: null,
        carrier: null,
        referenceCode: null,
        bookingStatus: 'BOOKED',
        sourceMaterialId: null,
      },
    });
    const result = await service.getTrip(USER, trip.id);
    expect(result.legs).toHaveLength(1);
    expect(result.timeStatus).toBe('NO_CONFIRMED_DATES');
  });
});

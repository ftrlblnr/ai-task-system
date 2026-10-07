/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma, тот же приём, что reception.service.spec.ts */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventSource, EventStatus } from '@prisma/client';
import { EventsService } from './events.service';

interface FakeEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  status: EventStatus;
  version: number;
  lastModifiedBy: EventSource;
  googleEventId: string | null;
  googleEtag: string | null;
  createdById: string;
}

function applyUpdate(row: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
      row[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else {
      row[key] = value;
    }
  }
}

class FakePrisma {
  events: FakeEvent[] = [];
  participants: { eventId: string; employeeId: string }[] = [];
  seq = 0;

  private withParticipants(e: FakeEvent) {
    return { ...e, participants: this.participants.filter((p) => p.eventId === e.id).map((p) => ({ employee: { id: p.employeeId, fullName: 'X' } })) };
  }

  event = {
    create: async ({ data }: { data: Partial<FakeEvent> }) => {
      const row: FakeEvent = {
        id: `e${++this.seq}`,
        description: null,
        location: null,
        allDay: false,
        status: EventStatus.CONFIRMED,
        version: 1,
        lastModifiedBy: EventSource.INTERNAL,
        googleEventId: null,
        googleEtag: null,
        ...data,
      } as FakeEvent;
      this.events.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.events.find((e) => e.id === where.id);
      return row ? this.withParticipants(row) : null;
    },
    findMany: async ({ where }: { where: { createdById: string } }) =>
      this.events.filter((e) => e.createdById === where.createdById).map((e) => this.withParticipants(e)),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.events.find((e) => e.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: { id: string; version: number }; data: Record<string, unknown> }) => {
      const matches = this.events.filter((e) => e.id === where.id && e.version === where.version);
      for (const row of matches) applyUpdate(row, data);
      return { count: matches.length };
    },
    delete: async ({ where }: { where: { id: string } }) => {
      this.events = this.events.filter((e) => e.id !== where.id);
    },
  };

  eventParticipant = {
    upsert: async ({ create }: { create: { eventId: string; employeeId: string } }) => {
      if (!this.participants.some((p) => p.eventId === create.eventId && p.employeeId === create.employeeId)) {
        this.participants.push(create);
      }
    },
    deleteMany: async ({ where }: { where: { eventId: string; employeeId: string } }) => {
      this.participants = this.participants.filter((p) => !(p.eventId === where.eventId && p.employeeId === where.employeeId));
    },
  };

  employee = {
    findUnique: async () => ({ telegramId: null }),
  };
}

describe('EventsService (календарный агент, раздел 4 ТЗ: объектные права)', () => {
  let prisma: FakePrisma;
  let sync: { pushEvent: jest.Mock; deleteFromGoogle: jest.Mock };
  let bot: { sendMessage: jest.Mock };
  let service: EventsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    sync = { pushEvent: jest.fn().mockResolvedValue(undefined), deleteFromGoogle: jest.fn().mockResolvedValue(undefined) };
    bot = { sendMessage: jest.fn().mockResolvedValue(undefined) };
    service = new EventsService(prisma as never, sync as never, bot as never);
  });

  async function createFor(ownerId: string) {
    return service.create({ title: 'Встреча', startAt: '2026-10-10T10:00:00.000Z', endAt: '2026-10-10T10:30:00.000Z' }, ownerId);
  }

  it('C06: владелец видит своё событие через findOne', async () => {
    const event = await createFor('owner-1');
    await expect(service.findOne(event.id, 'owner-1')).resolves.toMatchObject({ id: event.id });
  });

  it('C06: другой OWNER не читает событие по угаданному id — 404', async () => {
    const event = await createFor('owner-1');
    await expect(service.findOne(event.id, 'owner-2')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('C06: другой OWNER не может обновить чужое событие', async () => {
    const event = await createFor('owner-1');
    await expect(service.update(event.id, { title: 'Подмена' }, 'owner-2')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.events[0].title).toBe('Встреча');
  });

  it('C06: другой OWNER не может удалить чужое событие', async () => {
    const event = await createFor('owner-1');
    await expect(service.remove(event.id, 'owner-2')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.events).toHaveLength(1);
  });

  it('C06: другой OWNER не может добавить/убрать участника чужого события', async () => {
    const event = await createFor('owner-1');
    await expect(service.addParticipant(event.id, 'emp1', 'owner-2')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.removeParticipant(event.id, 'emp1', 'owner-2')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.participants).toHaveLength(0);
  });

  it('C40: сбой удаления в Google не удаляет локальное событие', async () => {
    const event = await createFor('owner-1');
    prisma.events[0].googleEventId = 'g1';
    sync.deleteFromGoogle.mockRejectedValueOnce(new Error('Google недоступен'));

    await expect(service.remove(event.id, 'owner-1')).rejects.toThrow('Google недоступен');
    expect(prisma.events).toHaveLength(1);
  });

  it('удаление ещё не синкнутого в Google события (googleEventId=null) не трогает Google', async () => {
    const event = await createFor('owner-1');
    await service.remove(event.id, 'owner-1');
    expect(sync.deleteFromGoogle).not.toHaveBeenCalled();
    expect(prisma.events).toHaveLength(0);
  });

  it('владелец может добавить участника своего события', async () => {
    const event = await createFor('owner-1');
    await service.addParticipant(event.id, 'emp1', 'owner-1');
    expect(prisma.participants).toEqual([{ eventId: event.id, employeeId: 'emp1' }]);
  });

  it('findAll возвращает только события текущего владельца', async () => {
    await createFor('owner-1');
    await createFor('owner-2');
    const all = await service.findAll('owner-1');
    expect(all).toHaveLength(1);
  });

  describe('раздел 17 ТЗ: optimistic concurrency', () => {
    it('без version — правка проходит как раньше, version всё равно увеличивается', async () => {
      const event = await createFor('owner-1');
      const updated = await service.update(event.id, { title: 'Новое' }, 'owner-1');
      expect(updated.title).toBe('Новое');
      expect(prisma.events[0].version).toBe(2);
    });

    it('с верной version — правка проходит, version увеличивается', async () => {
      const event = await createFor('owner-1');
      const updated = await service.update(event.id, { title: 'Новое', version: 1 }, 'owner-1');
      expect(updated.title).toBe('Новое');
      expect(prisma.events[0].version).toBe(2);
    });

    it('с устаревшей version — 409, правка не применяется', async () => {
      const event = await createFor('owner-1');
      await service.update(event.id, { title: 'Первая правка' }, 'owner-1'); // version теперь 2

      await expect(service.update(event.id, { title: 'Вторая правка', version: 1 }, 'owner-1')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.events[0].title).toBe('Первая правка');
    });
  });
});

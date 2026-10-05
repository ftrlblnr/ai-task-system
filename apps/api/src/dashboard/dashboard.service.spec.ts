/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma */
import { TaskStatus } from '@prisma/client';
import { DashboardService } from './dashboard.service';

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  dueDate: Date | null;
  assignee: { id: string; fullName: string } | null;
  parentTaskId: string | null;
}

class FakePrisma {
  tasks: TaskRow[] = [];

  task = {
    count: async ({ where }: { where: any }) => this.filter(where).length,
    findMany: async ({ where, take }: { where: any; take?: number }) => {
      const rows = this.filter(where);
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    },
  };

  private filter(where: any): TaskRow[] {
    return this.tasks.filter((t) => {
      if (where.parentTaskId !== undefined && t.parentTaskId !== where.parentTaskId) return false;
      if (where.status) {
        if (where.status.notIn && where.status.notIn.includes(t.status)) return false;
        if (typeof where.status === 'string' && t.status !== where.status) return false;
      }
      if (where.dueDate?.lt) {
        if (!t.dueDate || !(t.dueDate < where.dueDate.lt)) return false;
      }
      return true;
    });
  }
}

function task(partial: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    title: partial.title ?? 'Задача',
    status: partial.status ?? TaskStatus.NEW,
    dueDate: partial.dueDate ?? null,
    assignee: partial.assignee ?? null,
    parentTaskId: partial.parentTaskId ?? null,
    ...partial,
  };
}

function buildService(prisma: FakePrisma, reception: any = { getQueueView: jest.fn() }, events: any = { findUpcoming: jest.fn() }) {
  return new DashboardService(prisma as any, reception, events);
}

describe('DashboardService.getOverview («Стол руководителя», владелец 05.10.2026)', () => {
  const user = { id: 'owner-1' } as any;

  it('считает active/overdue/inReview отдельными COUNT, не по длине items', async () => {
    const prisma = new FakePrisma();
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);
    prisma.tasks = [
      task({ id: 't1', status: TaskStatus.NEW, dueDate: past }), // active + overdue
      task({ id: 't2', status: TaskStatus.IN_REVIEW }), // active + inReview
      task({ id: 't3', status: TaskStatus.IN_PROGRESS, dueDate: future }), // active, не overdue
      task({ id: 't4', status: TaskStatus.DONE, dueDate: past }), // не active (DONE исключён, даже если dueDate в прошлом)
      task({ id: 't5', status: TaskStatus.CANCELLED }), // не active
    ];
    const reception = { getQueueView: jest.fn().mockResolvedValue({ current: null, items: [], totalCount: 0, totalWaiting: 0 }) };
    const events = { findUpcoming: jest.fn().mockResolvedValue([]) };
    const service = buildService(prisma, reception, events);

    const result = await service.getOverview(user);

    expect(result.tasks).toMatchObject({ status: 'ok', counts: { active: 3, overdue: 1, inReview: 1 } });
  });

  it('сортирует «В центре внимания»: просроченные → IN_REVIEW → по сроку → по id, топ-5', async () => {
    const prisma = new FakePrisma();
    const past = new Date(Date.now() - 1000);
    const soon = new Date(Date.now() + 1000);
    const later = new Date(Date.now() + 2000);
    prisma.tasks = [
      task({ id: 'b-no-due', status: TaskStatus.NEW, dueDate: null }),
      task({ id: 'a-no-due', status: TaskStatus.NEW, dueDate: null }),
      task({ id: 'due-later', status: TaskStatus.NEW, dueDate: later }),
      task({ id: 'due-soon', status: TaskStatus.NEW, dueDate: soon }),
      task({ id: 'in-review', status: TaskStatus.IN_REVIEW, dueDate: null }),
      task({ id: 'overdue', status: TaskStatus.IN_PROGRESS, dueDate: past }),
      task({ id: 'z-no-due', status: TaskStatus.NEW, dueDate: null }),
    ];
    const reception = { getQueueView: jest.fn().mockResolvedValue({ current: null, items: [], totalCount: 0, totalWaiting: 0 }) };
    const events = { findUpcoming: jest.fn().mockResolvedValue([]) };
    const service = buildService(prisma, reception, events);

    const result = await service.getOverview(user);

    expect(result.tasks.status).toBe('ok');
    const ids = (result.tasks as any).items.map((t: any) => t.id);
    // overdue первой; затем in-review; затем по сроку возрастание (due-soon
    // раньше due-later); без срока — в конец группы, тай-брейк по id
    // (a-no-due < b-no-due), и ровно 5 из 7 кандидатов (топ-5, не все).
    expect(ids).toEqual(['overdue', 'in-review', 'due-soon', 'due-later', 'a-no-due']);
    expect(ids).toHaveLength(5);
  });

  it('один упавший источник не ломает остальные — reception падает, tasks/calendar остаются ok', async () => {
    const prisma = new FakePrisma();
    prisma.tasks = [task({ id: 't1', status: TaskStatus.NEW })];
    const reception = { getQueueView: jest.fn().mockRejectedValue(new Error('db unreachable')) };
    const events = { findUpcoming: jest.fn().mockResolvedValue([{ id: 'e1', title: 'Встреча', startAt: new Date(), endAt: new Date(), allDay: false }]) };
    const service = buildService(prisma, reception, events);

    const result = await service.getOverview(user);

    expect(result.tasks.status).toBe('ok');
    expect(result.calendar.status).toBe('ok');
    expect(result.reception).toMatchObject({ status: 'error', fetchedAt: null });
    // Безопасное сообщение, не текст исключения наружу (раздел 15 ТЗ).
    expect((result.reception as any).message).not.toMatch(/db unreachable/);
  });

  it('очередь приёмной — текущий вызов НЕ входит в waitingCount (переиспользует getQueueView как есть)', async () => {
    const prisma = new FakePrisma();
    const current = { id: 'r1', notificationStatus: 'SENT' };
    const reception = {
      getQueueView: jest.fn().mockResolvedValue({ current, items: [{ id: 'r2' }, { id: 'r3' }], totalCount: 2, totalWaiting: 2 }),
    };
    const events = { findUpcoming: jest.fn().mockResolvedValue([]) };
    const service = buildService(prisma, reception, events);

    const result = await service.getOverview(user);

    expect(result.reception).toMatchObject({ status: 'ok', waitingCount: 2, current });
    expect((result.reception as any).items).toHaveLength(2);
    expect(reception.getQueueView).toHaveBeenCalledWith({}, 3, 0);
  });

  it('calendar вызывает findUpcoming с лимитом 3 для текущего пользователя', async () => {
    const prisma = new FakePrisma();
    const reception = { getQueueView: jest.fn().mockResolvedValue({ current: null, items: [], totalCount: 0, totalWaiting: 0 }) };
    const events = { findUpcoming: jest.fn().mockResolvedValue([]) };
    const service = buildService(prisma, reception, events);

    await service.getOverview(user);

    expect(events.findUpcoming).toHaveBeenCalledWith('owner-1', 3);
  });
});

import { DashboardPanelsService } from './dashboard-panels.service';

// Панели пульта — на заглушках Prisma, без БД.

function service(prisma: Record<string, unknown>, aiUsage: unknown = {}) {
  return new DashboardPanelsService(prisma as never, aiUsage as never);
}

describe('пульт: панели', () => {
  it('почта не подключена — пустая панель без запросов писем', async () => {
    const count = jest.fn();
    const out = await service({
      mailbox: { findMany: () => Promise.resolve([]) },
      emailMessage: { count },
    }).mail('u1');
    expect(out).toMatchObject({
      status: 'ok',
      connected: false,
      received24h: 0,
      needsYou: [],
      lastSyncedAt: null,
    });
    expect(count).not.toHaveBeenCalled();
  });

  it('почта: «требует вас» с отправителем и сводкой, микс по убыванию, последняя синхронизация', async () => {
    const synced = new Date('2026-10-25T05:00:00Z');
    const prisma = {
      mailbox: {
        findMany: () =>
          Promise.resolve([
            { id: 'm1', lastSyncedAt: new Date('2026-10-24T05:00:00Z') },
            { id: 'm2', lastSyncedAt: synced },
          ]),
      },
      emailMessage: {
        count: () => Promise.resolve(12),
        findMany: () =>
          Promise.resolve([
            {
              id: 'e1',
              subject: 'Смета',
              fromName: null,
              fromAddress: 'a@b.kz',
              receivedAt: synced,
              analysis: {
                importance: 'IMPORTANT',
                needsReply: true,
                summary: 'x'.repeat(300),
              },
            },
          ]),
      },
      emailAnalysis: {
        groupBy: () =>
          Promise.resolve([
            { category: 'INFORMATION', _count: { _all: 2 } },
            { category: 'ACTION_REQUIRED', _count: { _all: 5 } },
          ]),
      },
    };
    const out = await service(prisma).mail('u1');
    expect(out.received24h).toBe(12);
    expect(out.needsYou[0]).toMatchObject({
      id: 'e1',
      from: 'a@b.kz',
      importance: 'IMPORTANT',
      needsReply: true,
    });
    expect(out.needsYou[0].summary).toHaveLength(160);
    expect(out.mix.map((m) => m.category)).toEqual([
      'ACTION_REQUIRED',
      'INFORMATION',
    ]);
    expect(out.lastSyncedAt).toBe(synced.toISOString());
  });

  it('регламенты: сегодняшние прогоны, затем ближайшие запуски со статусом NEXT', async () => {
    const at = new Date('2026-10-25T04:00:00Z');
    const prisma = {
      routine: {
        findMany: () =>
          Promise.resolve([
            {
              id: 'r2',
              title: 'Письма',
              nextRunAt: new Date('2026-10-26T04:00:00Z'),
            },
          ]),
        count: () => Promise.resolve(3),
      },
      routineRun: {
        findMany: () =>
          Promise.resolve([
            {
              id: 'run1',
              status: 'SILENT',
              createdAt: at,
              finishedAt: null,
              conversationId: null,
              routine: { id: 'r1', title: 'Просрочки' },
            },
          ]),
      },
    };
    const out = await service(prisma).routines('u1');
    expect(out.activeCount).toBe(3);
    expect(out.items.map((i) => [i.title, i.status])).toEqual([
      ['Просрочки', 'SILENT'],
      ['Письма', 'NEXT'],
    ]);
  });

  it('навыки: по запускам за 30 дней, не больше шести', async () => {
    const skills = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`,
      slug: `n${i}`,
      title: `Н${i}`,
      description: '',
      kind: 'ACTION',
      model: 'HAIKU',
      effort: 'LOW',
    }));
    const prisma = {
      skill: { findMany: () => Promise.resolve(skills) },
      skillRun: {
        groupBy: () =>
          Promise.resolve([{ skillId: 's7', _count: { _all: 4 } }]),
      },
    };
    const out = await service(prisma).skills('u1');
    expect(out.total).toBe(8);
    expect(out.items).toHaveLength(6);
    expect(out.items[0]).toMatchObject({ id: 's7', runs30d: 4 });
    expect(out.all).toHaveLength(8);
  });

  it('расход: токены — вход, выход и кэш вместе', async () => {
    const total = {
      calls: 2,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 50,
      costUsd: 0.5,
      cacheShare: 0.8,
    };
    const aiUsage = {
      summary: (days: number) =>
        Promise.resolve({ total: { ...total, calls: days }, daily: [] }),
    };
    const out = await service({}, aiUsage).usage();
    expect(out.today).toEqual({
      calls: 1,
      tokens: 1000,
      costUsd: 0.5,
      cacheShare: 0.8,
    });
    expect(out.week.calls).toBe(7);
  });
});

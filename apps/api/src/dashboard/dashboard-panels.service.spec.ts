import { DashboardPanelsService } from './dashboard-panels.service';

// Панели пульта — на заглушках Prisma, без БД.

function service(
  prisma: Record<string, unknown>,
  aiUsage: unknown = {},
  mail: { mailbox?: object | null; summary?: object } = {},
) {
  const store = { findOwnedMailbox: jest.fn().mockResolvedValue(mail.mailbox ?? null) };
  const triage = { summary: jest.fn().mockResolvedValue(mail.summary ?? { total: 0, needsReply: 0, top: [] }) };
  return { panels: new DashboardPanelsService(prisma as never, aiUsage as never, store as never, triage as never), store, triage };
}

describe('пульт: панели', () => {
  it('почта не подключена — пустая панель без запросов писем', async () => {
    const count = jest.fn();
    const { panels, triage } = service({ emailMessage: { count } });
    const out = await panels.mail('u1');
    expect(out).toMatchObject({
      status: 'ok',
      connected: false,
      received24h: 0,
      needsReply: 0,
      top: [],
      lastSyncedAt: null,
    });
    expect(count).not.toHaveBeenCalled();
    expect(triage.summary).not.toHaveBeenCalled();
  });

  it('почта: «ждут ответа» и первые письма — из очереди «Разбора», микс по убыванию, последняя синхронизация', async () => {
    const synced = new Date('2026-10-25T05:00:00Z');
    const prisma = {
      emailMessage: { count: () => Promise.resolve(12) },
      emailAnalysis: {
        groupBy: () =>
          Promise.resolve([
            { category: 'INFORMATION', _count: { _all: 2 } },
            { category: 'ACTION_REQUIRED', _count: { _all: 5 } },
          ]),
      },
      mailbox: { aggregate: () => Promise.resolve({ _max: { lastSyncedAt: synced } }) },
    };
    const top = [{ id: 'e1', subject: 'Смета', fromName: null, fromAddress: 'a@b.kz', receivedAt: synced, importance: 'IMPORTANT', tag: 'REPLY' }];
    const { panels, triage } = service(prisma, {}, { mailbox: { id: 'mb1' }, summary: { total: 4, needsReply: 2, top } });
    const out = await panels.mail('u1');
    expect(triage.summary).toHaveBeenCalledWith('mb1', 3);
    expect(out.received24h).toBe(12);
    expect(out.needsReply).toBe(2);
    expect(out.top).toEqual([{ id: 'e1', subject: 'Смета', from: 'a@b.kz', receivedAt: synced.toISOString(), importance: 'IMPORTANT', tag: 'REPLY' }]);
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
    const out = await service(prisma).panels.routines('u1');
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
    const out = await service(prisma).panels.skills('u1');
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
    const out = await service({}, aiUsage).panels.usage();
    expect(out.today).toEqual({
      calls: 1,
      tokens: 1000,
      costUsd: 0.5,
      cacheShare: 0.8,
    });
    expect(out.week.calls).toBe(7);
  });
});

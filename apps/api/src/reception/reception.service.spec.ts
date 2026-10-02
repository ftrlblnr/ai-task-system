/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ReceptionService } from './reception.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

interface FakeRequest {
  id: string;
  queueId: string;
  authorId: string;
  title: string;
  description: string;
  requestType: string;
  expectedMinutes: number | null;
  desiredBy: Date | null;
  urgencyReason: string | null;
  status: string;
  queueOrder: bigint;
  version: number;
  lastCalledAt: Date | null;
  closedAt: Date | null;
  rejectionReason: string | null;
  resolution: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeNotification {
  id: string;
  eventId: string;
  requestId: string;
  recipientId: string;
  kind: string;
  status: string;
}

// Фейковый Prisma — тот же приём, что FakeStore в mail-sync.service.spec.ts:
// юнит-тесты проверяют ВЕТВЛЕНИЕ сервиса (классификация ошибок, нормализация
// полей, когда создаётся событие/уведомление), не настоящую атомарность
// Postgres (партициальный уникальный индекс "один CALLED", гонки под реальной
// конкурентностью) — это намеренно оставлено интеграционным тестам на
// реальном Postgres (раздел R7 плана, раздел 16 ТЗ).
class FakePrisma {
  requests: FakeRequest[] = [];
  events: { id: string; requestId: string; actorId: string; type: string; fromStatus: string | null; toStatus: string; requestVersion: number; metadata: unknown }[] = [];
  notifications: FakeNotification[] = [];
  employees = new Map<string, { id: string; fullName: string; status: string }>([
    ['boss', { id: 'boss', fullName: 'Руководитель', status: 'ACTIVE' }],
    ['e1', { id: 'e1', fullName: 'Сотрудник 1', status: 'ACTIVE' }],
    ['e2', { id: 'e2', fullName: 'Сотрудник 2', status: 'ACTIVE' }],
  ]);
  nextOrderCounter = 1n;
  seq = 0;

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }

  // Специализированная заглушка — единственный $queryRaw в сервисе
  // атомарно инкрементирует ReceptionQueue.nextOrder и возвращает
  // назначенное значение; реальный SQL не парсится, семантика
  // воспроизведена напрямую.
  async $queryRaw(): Promise<{ assigned: bigint }[]> {
    const assigned = this.nextOrderCounter;
    this.nextOrderCounter += 1n;
    return [{ assigned }];
  }

  receptionQueue = {
    upsert: async () => ({ id: 'default' }),
  };

  private withAuthor(r: FakeRequest) {
    const author = this.employees.get(r.authorId)!;
    return { ...r, author: { id: author.id, fullName: author.fullName, status: author.status } };
  }

  receptionRequest = {
    create: async ({ data }: { data: Partial<FakeRequest> }) => {
      const now = new Date();
      const row: FakeRequest = {
        id: `r${++this.seq}`,
        queueId: 'default',
        version: 1,
        status: 'WAITING',
        lastCalledAt: null,
        closedAt: null,
        rejectionReason: null,
        resolution: null,
        createdAt: now,
        updatedAt: now,
        expectedMinutes: null,
        desiredBy: null,
        urgencyReason: null,
        ...data,
      } as FakeRequest;
      this.requests.push(row);
      return this.withAuthor(row);
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = this.requests.find((r) => r.id === where.id);
      return row ? this.withAuthor(row) : null;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = this.requests.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      return this.withAuthor(row);
    },
    findFirst: async ({ where }: { where: { queueId: string; status: string } }) => {
      const row = this.requests.find((r) => r.queueId === where.queueId && r.status === where.status);
      return row ? this.withAuthor(row) : null;
    },
    findMany: async ({ where, orderBy, take, skip }: { where: any; orderBy?: any; take?: number; skip?: number }) => {
      let rows = this.requests.filter((r) => matches(r, where));
      rows = sortRows(rows, orderBy);
      if (skip) rows = rows.slice(skip);
      if (take) rows = rows.slice(0, take);
      return rows.map((r) => this.withAuthor(r));
    },
    count: async ({ where }: { where: any }) => this.requests.filter((r) => matches(r, where)).length,
    aggregate: async ({ where, _max }: { where: any; _max: { queueOrder: true } }) => {
      void _max;
      const rows = this.requests.filter((r) => matches(r, where));
      const max = rows.length ? rows.reduce((a, b) => (b.queueOrder > a ? b.queueOrder : a), rows[0].queueOrder) : null;
      return { _max: { queueOrder: max } };
    },
    updateMany: async ({ where, data }: { where: any; data: any }) => {
      const matched = this.requests.filter((r) => matches(r, where));
      for (const row of matched) {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as any)) {
            (row as any)[k] += (v as any).increment;
          } else {
            (row as any)[k] = v;
          }
        }
        row.updatedAt = new Date();
      }
      return { count: matched.length };
    },
  };

  receptionEvent = {
    create: async ({ data }: { data: any }) => {
      const event = { id: `ev${++this.seq}`, ...data };
      this.events.push(event);
      return event;
    },
  };

  receptionNotification = {
    create: async ({ data }: { data: any }) => {
      const n: FakeNotification = { id: `n${++this.seq}`, status: 'PENDING', ...data };
      this.notifications.push(n);
      return n;
    },
    updateMany: async ({ where, data }: { where: any; data: any }) => {
      const matched = this.notifications.filter((n) => matchesNotification(n, where));
      for (const n of matched) Object.assign(n, data);
      return { count: matched.length };
    },
  };
}

function matches(row: FakeRequest, where: any): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(v as any[]).every((cond) => matches(row, cond))) return false;
      continue;
    }
    if (k === 'OR') {
      if (!(v as any[]).some((cond) => matches(row, cond))) return false;
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const current = (row as any)[k];
      if ('in' in (v as any) && !(v as any).in.includes(current)) return false;
      if ('lt' in (v as any) && !(current < (v as any).lt)) return false;
      if ('gte' in (v as any) && !(current >= (v as any).gte)) return false;
      if ('lte' in (v as any) && !(current <= (v as any).lte)) return false;
      continue;
    }
    if ((row as any)[k] !== v) return false;
  }
  return true;
}

function matchesNotification(row: FakeNotification, where: any): boolean {
  for (const [k, v] of Object.entries(where)) {
    if ((row as any)[k] !== v) return false;
  }
  return true;
}

function sortRows(rows: FakeRequest[], orderBy: any): FakeRequest[] {
  if (!orderBy) return rows;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [key, dir] = Object.entries(clause)[0] as [string, 'asc' | 'desc'];
      const av = (a as any)[key];
      const bv = (b as any)[key];
      if (av === bv) continue;
      const cmp = av > bv ? 1 : -1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

function user(id: string, role: 'OWNER' | 'EMPLOYEE' = 'EMPLOYEE'): AuthenticatedUser {
  return { id, email: `${id}@x.com`, role, isProfileAdmin: false };
}

function baseDto() {
  return { title: 'Согласовать бюджет', description: 'Нужно решение по бюджету на новое оборудование.', requestType: 'APPROVAL' as const };
}

describe('ReceptionService.create', () => {
  it('назначает возрастающий queueOrder, создаёт событие CREATED', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);

    const first = await service.create(user('e1'), baseDto());
    const second = await service.create(user('e2'), baseDto());

    expect(BigInt(second.queueOrder)).toBeGreaterThan(BigInt(first.queueOrder));
    expect(first.queueOrder).toEqual(expect.any(String)); // BigInt сериализован строкой
    expect(prisma.events).toContainEqual(expect.objectContaining({ requestId: first.id, type: 'CREATED', toStatus: 'WAITING' }));
  });

  it('desiredBy в прошлом — отклоняется', async () => {
    const service = new ReceptionService(new FakePrisma() as any);
    await expect(service.create(user('e1'), { ...baseDto(), desiredBy: new Date(Date.now() - 1000).toISOString() })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('ReceptionService.edit', () => {
  it('автор редактирует своё WAITING-обращение, версия увеличивается', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    const edited = await service.edit(user('e1'), created.id, { title: 'Новое название', version: created.version });

    expect(edited.title).toBe('Новое название');
    expect(edited.version).toBe(created.version + 1);
  });

  it('чужое обращение — 404, не 409/403 (не подтверждаем существование)', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    await expect(service.edit(user('e2'), created.id, { title: 'X', version: created.version })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('устаревшая version — 409 VERSION_CONFLICT', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    await expect(service.edit(user('e1'), created.id, { title: 'X', version: created.version + 1 })).rejects.toThrow(/VERSION_CONFLICT/);
  });
});

describe('ReceptionService.withdraw', () => {
  it('WAITING → WITHDRAWN, closedAt проставлен', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    const result = await service.withdraw(user('e1'), created.id, created.version);

    expect(result.status).toBe('WITHDRAWN');
    expect(prisma.requests[0].closedAt).not.toBeNull();
  });
});

describe('ReceptionService.moveToEnd', () => {
  it('переносит в конец очереди (новый queueOrder больше остальных)', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const a = await service.create(user('e1'), baseDto());
    const b = await service.create(user('e2'), baseDto());

    const moved = await service.moveToEnd(user('boss', 'OWNER'), a.id, a.version);

    expect(BigInt(moved.queueOrder)).toBeGreaterThan(BigInt(b.queueOrder));
    expect(moved.version).toBe(a.version + 1);
  });

  it('обращение уже последнее — без изменений, без нового события', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const a = await service.create(user('e1'), baseDto());
    await service.create(user('e2'), baseDto());
    const moved1 = await service.moveToEnd(user('boss', 'OWNER'), a.id, a.version); // теперь a — последнее
    const eventCountBefore = prisma.events.length;

    const moved2 = await service.moveToEnd(user('boss', 'OWNER'), a.id, moved1.version);

    expect(moved2.queueOrder).toBe(moved1.queueOrder);
    expect(moved2.version).toBe(moved1.version);
    expect(prisma.events).toHaveLength(eventCountBefore);
  });
});

describe('ReceptionService.call/reject/complete/returnToQueue', () => {
  it('call: WAITING → CALLED, создаёт PENDING-уведомление CALLED', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    const called = await service.call(user('boss', 'OWNER'), created.id, created.version);

    expect(called.status).toBe('CALLED');
    expect(prisma.notifications).toContainEqual(expect.objectContaining({ requestId: created.id, kind: 'CALLED', status: 'PENDING' }));
  });

  it('call: обращение не в WAITING — 409 INVALID_TRANSITION', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());
    const called = await service.call(user('boss', 'OWNER'), created.id, created.version);

    await expect(service.call(user('boss', 'OWNER'), created.id, called.version)).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('reject: пустая причина после trim сохраняется как null', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    await service.reject(user('boss', 'OWNER'), created.id, { version: created.version, reason: '   ' });

    expect(prisma.requests[0].rejectionReason).toBeNull();
    expect(prisma.requests[0].status).toBe('REJECTED');
    expect(prisma.notifications).toContainEqual(expect.objectContaining({ kind: 'REJECTED' }));
  });

  it('complete: CALLED → COMPLETED, снимает PENDING CALLED-уведомление (SUPERSEDED)', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());
    const called = await service.call(user('boss', 'OWNER'), created.id, created.version);

    await service.complete(user('boss', 'OWNER'), created.id, { version: called.version, resolution: 'Решили' });

    expect(prisma.requests[0].status).toBe('COMPLETED');
    expect(prisma.notifications.find((n) => n.kind === 'CALLED')!.status).toBe('SUPERSEDED');
  });

  it('returnToQueue: CALLED → WAITING в конец очереди, тоже снимает PENDING CALLED-уведомление', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const a = await service.create(user('e1'), baseDto());
    const b = await service.create(user('e2'), baseDto());
    const called = await service.call(user('boss', 'OWNER'), a.id, a.version);

    const returned = await service.returnToQueue(user('boss', 'OWNER'), a.id, called.version);

    expect(returned.status).toBe('WAITING');
    expect(BigInt(returned.queueOrder)).toBeGreaterThan(BigInt(b.queueOrder));
    expect(prisma.notifications.find((n) => n.kind === 'CALLED')!.status).toBe('SUPERSEDED');
    expect(prisma.notifications).toContainEqual(expect.objectContaining({ kind: 'RETURNED_TO_QUEUE' }));
  });
});

describe('ReceptionService чтение', () => {
  it('getOne: не-OWNER не может прочитать чужое обращение — 404', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    await expect(service.getOne(user('e2'), created.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getOne(user('boss', 'OWNER'), created.id)).resolves.toBeDefined();
  });

  it('getMine: active включает WAITING/CALLED, history — терминальные', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const a = await service.create(user('e1'), baseDto());
    await service.withdraw(user('e1'), a.id, a.version);
    const b = await service.create(user('e1'), baseDto());

    const active = await service.getMine(user('e1'), 'active', 30, 0);
    const history = await service.getMine(user('e1'), 'history', 30, 0);

    expect(active.items.map((i) => i.id)).toEqual([b.id]);
    expect(history.items.map((i) => i.id)).toEqual([a.id]);
  });
});

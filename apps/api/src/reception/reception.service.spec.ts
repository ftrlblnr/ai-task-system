/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
  tasks: any[] = [];
  templates: { id: string; text: string; sortOrder: number; createdAt: Date }[] = [];
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

  employee = {
    findFirst: async ({ where }: { where: { id: string; status: string } }) => {
      const e = this.employees.get(where.id);
      return e && e.status === where.status ? { id: e.id } : null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => (this.employees.has(where.id) ? { telegramId: `tg-${where.id}` } : null),
  };

  task = {
    create: async ({ data }: { data: any }) => {
      const row = { id: `t${++this.seq}`, ...data };
      this.tasks.push(row);
      return { id: row.id };
    },
  };

  receptionAnswerTemplate = {
    findMany: async () => [...this.templates].sort((a, b) => a.sortOrder - b.sortOrder).map(({ id, text }) => ({ id, text })),
    findFirst: async ({ where }: { where: { text: string } }) => {
      const t = this.templates.find((x) => x.text === where.text);
      return t ? { id: t.id, text: t.text } : null;
    },
    count: async () => this.templates.length,
    aggregate: async () => ({ _max: { sortOrder: this.templates.length ? Math.max(...this.templates.map((t) => t.sortOrder)) : null } }),
    create: async ({ data }: { data: { text: string; sortOrder: number } }) => {
      const t = { id: `tpl${++this.seq}`, createdAt: new Date(), ...data };
      this.templates.push(t);
      return { id: t.id, text: t.text };
    },
    deleteMany: async ({ where }: { where: { id: string } }) => {
      const before = this.templates.length;
      this.templates = this.templates.filter((t) => t.id !== where.id);
      return { count: before - this.templates.length };
    },
  };

  files: { id: string; employeeId: string; messageId: string | null; name: string; mimeType: string; size: number }[] = [];
  attachments: { requestId: string; fileId: string; name: string; mimeType: string; size: number }[] = [];

  fileArtifact = {
    findMany: async ({ where }: { where: { id: { in: string[] }; employeeId: string; messageId: null } }) =>
      this.files
        .filter((f) => where.id.in.includes(f.id) && f.employeeId === where.employeeId && f.messageId === null)
        .map((f) => {
          const a = this.attachments.find((x) => x.fileId === f.id);
          return { ...f, receptionAttachment: a ? { requestId: a.requestId } : null };
        }),
  };

  receptionAttachment = {
    deleteMany: async ({ where }: { where: { requestId: string; fileId: { notIn: string[] } } }) => {
      this.attachments = this.attachments.filter((a) => a.requestId !== where.requestId || where.fileId.notIn.includes(a.fileId));
    },
    createMany: async ({ data }: { data: FakePrisma['attachments'] }) => {
      this.attachments.push(...data);
    },
    findFirst: async ({ where }: { where: { requestId: string; fileId: string } }) =>
      this.attachments.find((a) => a.requestId === where.requestId && a.fileId === where.fileId) ?? null,
  };

  private withAuthor(r: FakeRequest) {
    const author = this.employees.get(r.authorId)!;
    const attachments = this.attachments.filter((a) => a.requestId === r.id).map(({ fileId, name, mimeType, size }) => ({ fileId, name, mimeType, size }));
    return { ...r, author: { id: author.id, fullName: author.fullName, status: author.status }, attachments };
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
    update: async ({ where, data }: { where: { id: string }; data: any }) => {
      const row = this.requests.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return this.withAuthor(row);
    },
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
    findFirst: async ({ where }: { where: any }) => this.notifications.filter((n) => matchesNotification(n, where)).at(-1) ?? null,
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
  return { id, email: `${id}@x.com`, role };
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

describe('ReceptionService — вложения автора', () => {
  function withFiles() {
    const prisma = new FakePrisma();
    const file = (id: string, employeeId = 'e1', messageId: string | null = null) => ({ id, employeeId, messageId, name: `${id}.pdf`, mimeType: 'application/pdf', size: 10 });
    prisma.files.push(file('f1'), file('f2'), file('f3'), file('other', 'e2'), file('sent', 'e1', 'm1'));
    return { prisma, service: new ReceptionService(prisma as any) };
  }

  it('при подаче — свои файлы привязываются и видны в обращении', async () => {
    const { service } = withFiles();
    const created = await service.create(user('e1'), { ...baseDto(), fileIds: ['f1', 'f2'] });
    expect(created.attachments.map((a: { fileId: string }) => a.fileId)).toEqual(['f1', 'f2']);
  });

  it('чужой, отправленный в чат или уже приложенный к другому обращению файл — отказ', async () => {
    const { service } = withFiles();
    for (const fileIds of [['other'], ['sent'], ['missing']]) {
      await expect(service.create(user('e1'), { ...baseDto(), fileIds })).rejects.toBeInstanceOf(BadRequestException);
    }
    await service.create(user('e1'), { ...baseDto(), fileIds: ['f1'] });
    await expect(service.create(user('e1'), { ...baseDto(), fileIds: ['f1'] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('правка заменяет список: убранные отвязываются, новые добавляются, в журнале — имена', async () => {
    const { prisma, service } = withFiles();
    const created = await service.create(user('e1'), { ...baseDto(), fileIds: ['f1', 'f2'] });
    const edited = await service.edit(user('e1'), created.id, { fileIds: ['f2', 'f3'], version: created.version });
    expect(edited.attachments.map((a: { fileId: string }) => a.fileId).sort()).toEqual(['f2', 'f3']);
    expect(prisma.events.at(-1)).toMatchObject({ type: 'EDITED', metadata: { attachments: ['f2.pdf', 'f3.pdf'] } });

    // Без fileIds вложения не трогаются.
    const again = await service.edit(user('e1'), created.id, { title: 'Другая тема вопроса', version: edited.version });
    expect(again.attachments).toHaveLength(2);
  });

  it('скачать вложение может автор и руководство, но не другой сотрудник', async () => {
    const { service } = withFiles();
    const created = await service.create(user('e1'), { ...baseDto(), fileIds: ['f1'] });
    await expect(service.assertAttachmentAccess(user('e1'), created.id, 'f1')).resolves.toBeUndefined();
    await expect(service.assertAttachmentAccess(user('owner', 'OWNER'), created.id, 'f1')).resolves.toBeUndefined();
    await expect(service.assertAttachmentAccess(user('e2'), created.id, 'f1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.assertAttachmentAccess(user('e1'), created.id, 'f2')).rejects.toBeInstanceOf(NotFoundException);
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

// Владелец 20.10.2026 — закрыть вопрос без встречи: ответом или «разберитесь сами».
describe('ReceptionService.answer/delegate', () => {
  it('answer из очереди: WAITING → ANSWERED, текст в resolution, уведомление ANSWERED', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    const answered = await service.answer(user('boss', 'OWNER'), created.id, { version: created.version, text: '  Согласовано  ' });

    expect(answered.status).toBe('ANSWERED');
    expect(answered.resolution).toBe('Согласовано');
    expect(answered.closedAt).toBeInstanceOf(Date);
    expect(prisma.events.at(-1)).toEqual(expect.objectContaining({ type: 'ANSWERED', fromStatus: 'WAITING', toStatus: 'ANSWERED' }));
    expect(prisma.notifications).toContainEqual(expect.objectContaining({ kind: 'ANSWERED', recipientId: 'e1', status: 'PENDING' }));
  });

  it('answer вызванному: CALLED → ANSWERED, неотправленный вызов снимается', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());
    const called = await service.call(user('boss', 'OWNER'), created.id, created.version);

    await service.answer(user('boss', 'OWNER'), created.id, { version: called.version, text: 'Делайте' });

    expect(prisma.requests[0].status).toBe('ANSWERED');
    expect(prisma.notifications.find((n) => n.kind === 'CALLED')!.status).toBe('SUPERSEDED');
  });

  it('answer пустым текстом — 400, статус не меняется', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    await expect(service.answer(user('boss', 'OWNER'), created.id, { version: created.version, text: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.requests[0].status).toBe('WAITING');
  });

  it('delegate: WAITING → DELEGATED, комментарий необязателен', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    const delegated = await service.delegate(user('boss', 'OWNER'), created.id, { version: created.version });

    expect(delegated.status).toBe('DELEGATED');
    expect(delegated.resolution).toBeNull();
    expect(prisma.notifications).toContainEqual(expect.objectContaining({ kind: 'DELEGATED' }));
  });

  it('закрытое обращение — 409 INVALID_TRANSITION', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());
    const delegated = await service.delegate(user('boss', 'OWNER'), created.id, { version: created.version });

    await expect(service.answer(user('boss', 'OWNER'), created.id, { version: delegated.version, text: 'X' })).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('устаревшая version — 409 VERSION_CONFLICT', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    await expect(service.delegate(user('boss', 'OWNER'), created.id, { version: created.version + 1 })).rejects.toThrow(/VERSION_CONFLICT/);
  });

  it('getBoard: очередь, вызов, «Разберитесь сами» и «Отвечено» (ответы и обсуждённые)', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const boss = user('boss', 'OWNER');
    const waiting = await service.create(user('e1'), baseDto());
    const toCall = await service.create(user('e2'), baseDto());
    const toDelegate = await service.create(user('e1'), baseDto());
    const toAnswer = await service.create(user('e2'), baseDto());
    const toComplete = await service.create(user('e1'), baseDto());
    await service.delegate(boss, toDelegate.id, { version: toDelegate.version });
    await service.answer(boss, toAnswer.id, { version: toAnswer.version, text: 'Да' });
    const c = await service.call(boss, toComplete.id, toComplete.version);
    await service.complete(boss, toComplete.id, { version: c.version });
    await service.call(boss, toCall.id, toCall.version);

    const board = await service.getBoard();

    expect(board.current?.id).toBe(toCall.id);
    expect(board.waiting.map((r) => r.id)).toEqual([waiting.id]);
    expect(board.delegated.map((r) => r.id)).toEqual([toDelegate.id]);
    expect(board.answered.map((r) => r.id).sort()).toEqual([toAnswer.id, toComplete.id].sort());
  });
});

describe('ReceptionService.reorder', () => {
  async function queueOf(prisma: FakePrisma) {
    return prisma.requests
      .filter((r) => r.status === 'WAITING')
      .sort((a, b) => (a.queueOrder < b.queueOrder ? -1 : 1))
      .map((r) => r.id);
  }

  it('ставит перед указанным, номера переразложены, version растёт только у перемещённого', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const a = await service.create(user('e1'), baseDto());
    const b = await service.create(user('e2'), baseDto());
    const c = await service.create(user('e1'), baseDto());

    const moved = await service.reorder(user('boss', 'OWNER'), c.id, c.version, a.id);

    expect(await queueOf(prisma)).toEqual([c.id, a.id, b.id]);
    expect(moved.version).toBe(c.version + 1);
    expect(prisma.requests.find((r) => r.id === a.id)!.version).toBe(a.version);
    const event = prisma.events.at(-1)!;
    expect(event.type).toBe('REORDERED');
    expect(event.metadata).toEqual({ fromPosition: 3, toPosition: 1 });
  });

  it('без beforeId — в конец', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const a = await service.create(user('e1'), baseDto());
    const b = await service.create(user('e2'), baseDto());
    const c = await service.create(user('e1'), baseDto());

    await service.reorder(user('boss', 'OWNER'), a.id, a.version);

    expect(await queueOf(prisma)).toEqual([b.id, c.id, a.id]);
  });

  it('то же место — без изменений и без события', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const a = await service.create(user('e1'), baseDto());
    const b = await service.create(user('e2'), baseDto());
    const eventsBefore = prisma.events.length;

    const result = await service.reorder(user('boss', 'OWNER'), a.id, a.version, b.id);

    expect(result.version).toBe(a.version);
    expect(prisma.events.length).toBe(eventsBefore);
  });

  it('beforeId уже не в очереди — 409 VERSION_CONFLICT', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const a = await service.create(user('e1'), baseDto());
    const b = await service.create(user('e2'), baseDto());
    await service.call(user('boss', 'OWNER'), a.id, a.version);

    await expect(service.reorder(user('boss', 'OWNER'), b.id, b.version, a.id)).rejects.toThrow(/VERSION_CONFLICT/);
  });

  it('устаревшая version — 409 VERSION_CONFLICT, порядок не меняется', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);
    const a = await service.create(user('e1'), baseDto());
    const b = await service.create(user('e2'), baseDto());

    await expect(service.reorder(user('boss', 'OWNER'), b.id, b.version + 1, a.id)).rejects.toThrow(/VERSION_CONFLICT/);
    expect(await queueOf(prisma)).toEqual([a.id, b.id]);
  });
});

describe('ReceptionService ответ с задачей и шаблоны', () => {
  it('ставит задачу автору вопроса по умолчанию и связывает её с вопросом', async () => {
    const prisma = new FakePrisma();
    const bot = { sendMessage: jest.fn() };
    const service = new ReceptionService(prisma as any, bot as any);
    const created = await service.create(user('e1'), baseDto());

    await service.answer(user('boss', 'OWNER'), created.id, {
      version: created.version,
      text: 'Согласовано',
      task: { title: ' Заказать оборудование ', dueDate: '2026-11-01T00:00:00.000Z' },
    });

    expect(prisma.tasks).toHaveLength(1);
    expect(prisma.tasks[0]).toMatchObject({ title: 'Заказать оборудование', assigneeId: 'e1', creatorId: 'boss', status: 'NEW' });
    expect(prisma.tasks[0].description).toContain('Согласовано');
    expect(prisma.requests[0]).toMatchObject({ status: 'ANSWERED', taskId: prisma.tasks[0].id });
    expect(bot.sendMessage).not.toHaveBeenCalled(); // автору — одним сообщением через outbox
  });

  it('неактивный исполнитель — 400, вопрос остаётся в очереди', async () => {
    const prisma = new FakePrisma();
    prisma.employees.set('gone', { id: 'gone', fullName: 'Уволен', status: 'INACTIVE' });
    const service = new ReceptionService(prisma as any);
    const created = await service.create(user('e1'), baseDto());

    await expect(
      service.answer(user('boss', 'OWNER'), created.id, { version: created.version, text: 'Да', task: { title: 'X', assigneeId: 'gone' } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.requests[0].status).toBe('WAITING');
    expect(prisma.tasks).toHaveLength(0);
  });

  it('шаблоны: обрезка пробелов, без дублей, удаление несуществующего — 404', async () => {
    const prisma = new FakePrisma();
    const service = new ReceptionService(prisma as any);

    const first = await service.createTemplate('  Согласовано. ');
    const again = await service.createTemplate('Согласовано.');
    await service.createTemplate('Зайдите после обеда.');

    expect(again.id).toBe(first.id);
    expect((await service.listTemplates()).map((t) => t.text)).toEqual(['Согласовано.', 'Зайдите после обеда.']);
    await service.deleteTemplate(first.id);
    expect(await service.listTemplates()).toHaveLength(1);
    await expect(service.deleteTemplate('nope')).rejects.toBeInstanceOf(NotFoundException);
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

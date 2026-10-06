/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma */
import { createHash } from 'node:crypto';
import { ConflictException, HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IdempotencyService } from './idempotency.service';

// Та же формула, что в самом сервисе (не экспортирована — хэш не часть
// публичного контракта) — нужна только для теста гонки ниже, где мы сами
// имитируем "чужой" claimed-ряд в сторе.
function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

interface Row {
  id: string;
  actorId: string;
  key: string;
  action: string;
  bodyHash: string;
  statusCode: number | null;
  response: unknown;
  createdAt: Date;
  completedAt: Date | null;
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '6.19.3' });
}

class FakePrisma {
  rows: Row[] = [];
  seq = 0;

  idempotencyKey = {
    create: async ({ data }: { data: { actorId: string; key: string; action: string; bodyHash: string } }) => {
      if (this.rows.some((r) => r.actorId === data.actorId && r.key === data.key)) throw p2002();
      const row: Row = { id: `k${++this.seq}`, statusCode: null, response: null, createdAt: new Date(), completedAt: null, ...data };
      this.rows.push(row);
      return row;
    },
    findUniqueOrThrow: async ({ where }: { where: { actorId_key: { actorId: string; key: string } } }) => {
      const row = this.rows.find((r) => r.actorId === where.actorId_key.actorId && r.key === where.actorId_key.key);
      if (!row) throw new Error('not found');
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = this.rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      this.rows = this.rows.filter((r) => r.id !== where.id);
    },
  };
}

describe('IdempotencyService', () => {
  it('без ключа в сторе — выполняет обработчик один раз, сохраняет результат', async () => {
    const prisma = new FakePrisma();
    const service = new IdempotencyService(prisma as any);
    const handler = jest.fn().mockResolvedValue({ id: 'r1' });

    const result = await service.run('e1', 'k1', 'reception.create', { title: 'A' }, handler);

    expect(result).toEqual({ statusCode: 200, body: { id: 'r1' } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(prisma.rows[0]).toMatchObject({ statusCode: 200, response: { id: 'r1' } });
  });

  it('повтор с тем же ключом и тем же телом — возвращает сохранённый результат, обработчик не вызывается снова', async () => {
    const prisma = new FakePrisma();
    const service = new IdempotencyService(prisma as any);
    const handler = jest.fn().mockResolvedValue({ id: 'r1' });

    await service.run('e1', 'k1', 'reception.create', { title: 'A' }, handler);
    const second = await service.run('e1', 'k1', 'reception.create', { title: 'A' }, handler);

    expect(second).toEqual({ statusCode: 200, body: { id: 'r1' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('повтор с тем же ключом, но ДРУГИМ телом — 409 IDEMPOTENCY_CONFLICT', async () => {
    const prisma = new FakePrisma();
    const service = new IdempotencyService(prisma as any);
    await service.run('e1', 'k1', 'reception.create', { title: 'A' }, jest.fn().mockResolvedValue({ id: 'r1' }));

    await expect(service.run('e1', 'k1', 'reception.create', { title: 'B' }, jest.fn())).rejects.toBeInstanceOf(ConflictException);
  });

  it('разные actorId с одним key — не конфликтуют (ключ уникален в паре с actorId)', async () => {
    const prisma = new FakePrisma();
    const service = new IdempotencyService(prisma as any);
    const r1 = await service.run('e1', 'k1', 'reception.create', { title: 'A' }, jest.fn().mockResolvedValue({ id: 'r1' }));
    const r2 = await service.run('e2', 'k1', 'reception.create', { title: 'A' }, jest.fn().mockResolvedValue({ id: 'r2' }));

    expect(r1.body).toEqual({ id: 'r1' });
    expect(r2.body).toEqual({ id: 'r2' });
  });

  it('обработчик бросает бизнес-ошибку (4xx) — сохраняется и воспроизводится при повторе', async () => {
    const prisma = new FakePrisma();
    const service = new IdempotencyService(prisma as any);
    const handler = jest.fn().mockRejectedValue(new ConflictException('VERSION_CONFLICT: обращение уже изменилось'));

    await expect(service.run('e1', 'k1', 'reception.call', {}, handler)).rejects.toBeInstanceOf(HttpException);
    expect(handler).toHaveBeenCalledTimes(1);

    // Повтор с тем же ключом/телом — та же ошибка, обработчик НЕ вызывается снова.
    await expect(service.run('e1', 'k1', 'reception.call', {}, handler)).rejects.toMatchObject({ status: 409 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('обработчик бросает инфраструктурную ошибку (5xx) — claim снимается, повтор выполняет обработчик заново', async () => {
    const prisma = new FakePrisma();
    const service = new IdempotencyService(prisma as any);
    const handler = jest.fn().mockRejectedValueOnce(new HttpException('db down', 500)).mockResolvedValueOnce({ id: 'r1' });

    await expect(service.run('e1', 'k1', 'reception.create', {}, handler)).rejects.toThrow('db down');
    expect(prisma.rows).toHaveLength(0);

    const result = await service.run('e1', 'k1', 'reception.create', {}, handler);
    expect(result.body).toEqual({ id: 'r1' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('обработчик бросает НЕ-HttpException (неожиданный сбой) — claim тоже снимается', async () => {
    const prisma = new FakePrisma();
    const service = new IdempotencyService(prisma as any);
    await expect(service.run('e1', 'k1', 'reception.create', {}, jest.fn().mockRejectedValue(new Error('boom')))).rejects.toThrow('boom');
    expect(prisma.rows).toHaveLength(0);
  });

  it('свежий claim без результата (гонка двух одновременных запросов) — второй получает IDEMPOTENCY_IN_PROGRESS, не выполняет обработчик', async () => {
    const prisma = new FakePrisma();
    const service = new IdempotencyService(prisma as any);
    // Имитация: первый запрос уже заклеймил строку (create прошёл), но ещё
    // не успел записать результат — ровно то состояние, в котором claim()
    // оставляет строку между созданием и complete()/release().
    prisma.rows.push({
      id: 'k1',
      actorId: 'e1',
      key: 'dup',
      action: 'reception.call',
      bodyHash: hashBody({}),
      statusCode: null,
      response: null,
      createdAt: new Date(),
      completedAt: null,
    });

    const handler = jest.fn();
    await expect(service.run('e1', 'dup', 'reception.call', {}, handler)).rejects.toBeInstanceOf(ConflictException);
    expect(handler).not.toHaveBeenCalled();
  });

  it('УСТАРЕВШИЙ claim без результата (процесс упал) — переиспользуется, обработчик выполняется', async () => {
    const prisma = new FakePrisma();
    const service = new IdempotencyService(prisma as any);
    prisma.rows.push({
      id: 'k1',
      actorId: 'e1',
      key: 'stale',
      action: 'reception.call',
      bodyHash: hashBody({}),
      statusCode: null,
      response: null,
      createdAt: new Date(Date.now() - 60_000), // старше STALE_CLAIM_MS
      completedAt: null,
    });

    const result = await service.run('e1', 'stale', 'reception.call', {}, jest.fn().mockResolvedValue({ ok: true }));
    expect(result.body).toEqual({ ok: true });
    expect(prisma.rows).toHaveLength(1);
  });
});

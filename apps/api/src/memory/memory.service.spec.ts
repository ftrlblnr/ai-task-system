import { NotFoundException } from '@nestjs/common';
import type { MemoryItem } from '@prisma/client';
import { MemoryService } from './memory.service';

// Простая подмена Prisma в памяти — проверяем правила сервиса (владелец,
// идемпотентность, повторы), не SQL.
function fakePrisma() {
  const rows: MemoryItem[] = [];
  let seq = 0;
  const matches = (row: MemoryItem, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
  const memoryItem = {
    findUnique: jest.fn(({ where }: { where: { id?: string; sourceKey?: string } }) => Promise.resolve(rows.find((r) => (where.id ? r.id === where.id : r.sourceKey === where.sourceKey)) ?? null)),
    findMany: jest.fn(({ where }: { where: Record<string, unknown> }) => Promise.resolve(rows.filter((r) => matches(r, where)))),
    create: jest.fn(({ data }: { data: Partial<MemoryItem> }) => {
      if (data.sourceKey && rows.some((r) => r.sourceKey === data.sourceKey)) return Promise.reject(new Error('dup'));
      const row = { id: `m${++seq}`, details: null, pinned: false, useCount: 0, lastUsedAt: null, sourceKey: null, createdAt: new Date(), updatedAt: new Date(), ...data } as MemoryItem;
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<MemoryItem> }) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return Promise.resolve(row);
    }),
    delete: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(rows.splice(rows.findIndex((r) => r.id === where.id), 1)[0])),
  };
  const prisma = { memoryItem, $transaction: <T>(cb: (tx: unknown) => Promise<T>) => cb({ memoryItem }) };
  return { prisma, rows };
}

describe('MemoryService', () => {
  it('remember идемпотентен по ключу вызова: повтор ответа не создаёт второй пункт', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new MemoryService(prisma as never);
    const first = await service.remember('owner', { kind: 'PREFERENCE', text: 'Отчёты присылать в xlsx' }, 'chat:u1:0');
    const again = await service.remember('owner', { kind: 'PREFERENCE', text: 'Отчёты в формате xlsx, пожалуйста' }, 'chat:u1:0');
    expect(again.item.id).toBe(first.item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('EXPLICIT');
    expect(rows[0].status).toBe('ACTIVE');
  });

  it('почти такой же активный пункт — повтор, второй не создаётся', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new MemoryService(prisma as never);
    await service.remember('owner', { kind: 'PREFERENCE', text: 'Отчёты присылать в xlsx' }, 'k1');
    const dup = await service.remember('owner', { kind: 'PREFERENCE', text: 'отчеты присылай в XLSX' }, 'k2');
    expect(dup.duplicate).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it('replacesId архивирует старый пункт владельца', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new MemoryService(prisma as never);
    const old = await service.remember('owner', { kind: 'PREFERENCE', text: 'Отчёты присылать в pdf' }, 'k1');
    const res = await service.remember('owner', { kind: 'PREFERENCE', text: 'Отчёты присылать в xlsx', replacesId: old.item.id }, 'k2');
    expect(res.replaced?.id).toBe(old.item.id);
    expect(rows.find((r) => r.id === old.item.id)?.status).toBe('ARCHIVED');
    expect(rows.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);
  });

  it('чужую память не видно и не тронуть', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new MemoryService(prisma as never);
    const mine = await service.remember('owner', { kind: 'FACT', text: 'Объект на Абая сдаётся в декабре' }, 'k1');
    await expect(service.forget('intruder', mine.item.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.update('intruder', mine.item.id, { text: 'взлом' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove('intruder', mine.item.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remember('intruder', { kind: 'FACT', text: 'другое', replacesId: mine.item.id }, 'k2')).rejects.toBeInstanceOf(NotFoundException);
    // Чужой ключ вызова тоже не отдаёт чужой пункт.
    await expect(service.remember('intruder', { kind: 'FACT', text: 'другое' }, 'k1')).rejects.toBeInstanceOf(NotFoundException);
    expect(rows[0].status).toBe('ACTIVE');
    expect(rows[0].text).toBe('Объект на Абая сдаётся в декабре');
  });

  it('forget — в архив, повтор безопасен; принять/отклонить предложение', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new MemoryService(prisma as never);
    const m = await service.remember('owner', { kind: 'FACT', text: 'Пункт' }, 'k1');
    await service.forget('owner', m.item.id);
    await service.forget('owner', m.item.id);
    expect(rows[0].status).toBe('ARCHIVED');

    rows.push({ ...rows[0], id: 'p1', status: 'PENDING', source: 'SUGGESTED', sourceKey: null });
    rows.push({ ...rows[0], id: 'p2', status: 'PENDING', source: 'SUGGESTED', sourceKey: null });
    expect((await service.decide('owner', 'p1', true)).status).toBe('ACTIVE');
    expect((await service.decide('owner', 'p2', false)).status).toBe('ARCHIVED');
  });
});

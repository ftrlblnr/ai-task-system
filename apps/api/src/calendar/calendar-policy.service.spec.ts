/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma, тот же приём, что reception.service.spec.ts */
import { ConflictException } from '@nestjs/common';
import { CalendarPolicyService } from './calendar-policy.service';
import { defaultAvailabilityPolicy } from './calendar-availability';

interface FakeRow {
  ownerId: string;
  version: number;
  timeZoneOffsetMinutes: number;
  workingHours: unknown;
  bufferMinutes: number;
  minNoticeHours: number;
  slotStepMinutes: number;
}

class FakePrisma {
  rows: FakeRow[] = [];

  calendarPolicy = {
    findUnique: async ({ where }: { where: { ownerId: string } }) => this.rows.find((r) => r.ownerId === where.ownerId) ?? null,
    create: async ({ data }: { data: Partial<FakeRow> & { ownerId: string } }) => {
      const row: FakeRow = { version: 1, timeZoneOffsetMinutes: 300, workingHours: [], bufferMinutes: 15, minNoticeHours: 4, slotStepMinutes: 15, ...data };
      this.rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { ownerId: string }; data: Record<string, unknown> }) => {
      const row = this.rows.find((r) => r.ownerId === where.ownerId)!;
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
          (row as unknown as Record<string, unknown>)[key] = (row as unknown as Record<string, number>)[key] + (value as { increment: number }).increment;
        } else {
          (row as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return row;
    },
  };
}

describe('CalendarPolicyService (ТЗ разд. 11/17)', () => {
  let prisma: FakePrisma;
  let service: CalendarPolicyService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new CalendarPolicyService(prisma as never);
  });

  it('без сохранённой политики возвращает встроенные значения по умолчанию с version=null', async () => {
    const view = await service.getOrDefault('owner-1');
    expect(view.version).toBeNull();
    expect(view).toMatchObject(defaultAvailabilityPolicy());
  });

  it('первое сохранение создаёт запись с version=1', async () => {
    const view = await service.update('owner-1', { bufferMinutes: 30 });
    expect(view.version).toBe(1);
    expect(view.bufferMinutes).toBe(30);
  });

  it('повторное сохранение без version — проходит, увеличивает version', async () => {
    await service.update('owner-1', { bufferMinutes: 30 });
    const view = await service.update('owner-1', { bufferMinutes: 45 });
    expect(view.version).toBe(2);
    expect(view.bufferMinutes).toBe(45);
  });

  it('сохранение с верной version — проходит', async () => {
    await service.update('owner-1', { bufferMinutes: 30 });
    const view = await service.update('owner-1', { bufferMinutes: 45, version: 1 });
    expect(view.version).toBe(2);
  });

  it('сохранение с устаревшей version — 409', async () => {
    await service.update('owner-1', { bufferMinutes: 30 }); // version 1
    await service.update('owner-1', { bufferMinutes: 45 }); // version 2
    await expect(service.update('owner-1', { bufferMinutes: 60, version: 1 })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.rows[0].bufferMinutes).toBe(45);
  });
});

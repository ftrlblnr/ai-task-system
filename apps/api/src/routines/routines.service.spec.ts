import { BadRequestException } from '@nestjs/common';
import { RoutineChannel, RoutineMode, RoutineState } from '@prisma/client';
import { RoutinesService, type RoutineInputData } from './routines.service';

// Проверки ввода и черновик из чата — без БД.

const base: RoutineInputData = { title: 'Сводка', prompt: 'Собери сводку по задачам', days: [1], time: '09:00', mode: RoutineMode.ACTIVE, channel: RoutineChannel.TELEGRAM };

function setup(skill: { enabled: boolean } = { enabled: true }) {
  const created: Record<string, unknown>[] = [];
  const byKey = new Map<string, unknown>();
  const prisma = {
    routine: {
      create: (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        const row = { id: `r${created.length}`, ...a.data };
        if (a.data.sourceKey) byKey.set(a.data.sourceKey as string, row);
        return Promise.resolve(row);
      },
      findUnique: (a: { where: { sourceKey: string } }) => Promise.resolve(byKey.get(a.where.sourceKey) ?? null),
      findMany: () => Promise.resolve([]),
    },
    routineRun: { groupBy: () => Promise.resolve([]), findMany: () => Promise.resolve([]) },
  };
  const skills = { findVisible: () => Promise.resolve(skill) };
  return { service: new RoutinesService(prisma as never, skills as never), created };
}

describe('регламенты: ввод', () => {
  it('ровно одно: навык или инструкция', async () => {
    const { service } = setup();
    await expect(service.proposeDraft('u1', { ...base, skillId: 's1' }, 'k1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.proposeDraft('u1', { ...base, prompt: '' }, 'k2')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('навык в архиве нельзя', async () => {
    const { service } = setup({ enabled: false });
    await expect(service.proposeDraft('u1', { ...base, prompt: null, skillId: 's1' }, 'k1')).rejects.toThrow('Навык в архиве');
  });

  it('лимит: 0 — без лимита, меньше 1000 — ошибка', async () => {
    const { service, created } = setup();
    await service.proposeDraft('u1', { ...base, weeklyTokenCap: 0 }, 'k1');
    expect(created[0].weeklyTokenCap).toBeNull();
    await expect(service.proposeDraft('u1', { ...base, weeklyTokenCap: 500 }, 'k2')).rejects.toThrow('Лимит');
  });

  it('без дней — только по кнопке', async () => {
    const { service, created } = setup();
    await service.proposeDraft('u1', { ...base, days: [] }, 'k1');
    expect(created[0].schedule).toBeNull();
    await service.proposeDraft('u1', { ...base, days: [1, 5], time: '18:30' }, 'k2');
    expect(created[1].schedule).toBe('30 18 * * 1,5');
  });

  it('черновик из чата: DRAFT, повтор того же вызова — тот же черновик', async () => {
    const { service, created } = setup();
    const a = await service.proposeDraft('u1', base, 'chat:m1:0');
    const b = await service.proposeDraft('u1', base, 'chat:m1:0');
    expect(created).toHaveLength(1);
    expect(created[0].state).toBe(RoutineState.DRAFT);
    expect(created[0].nextRunAt).toBeUndefined();
    expect(b).toBe(a);
  });
});

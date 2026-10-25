import { RecommendationGenerationService } from './recommendation-generation.service';
import { recoTargetKey } from './recommendation-prompt';

// Пятничный планировщик и ключи «уже было» — без БД и без модели.

describe('рекомендации: планировщик', () => {
  it('пятница: по прогону на руководителя, неделя — дата по Алматы, без дублей', async () => {
    let args: { data: unknown[]; skipDuplicates: boolean } | null = null;
    const prisma = {
      employee: { findMany: () => Promise.resolve([{ id: 'o1' }, { id: 'a1' }]) },
      recommendationBatch: {
        createMany: (a: { data: unknown[]; skipDuplicates: boolean }) => {
          args = a;
          return Promise.resolve({ count: a.data.length });
        },
      },
    };
    const service = new RecommendationGenerationService(prisma as never, {} as never);
    expect(await service.scheduleWeekly(new Date('2026-10-30T04:00:00Z'))).toBe(2);
    expect(args).toEqual({
      data: [
        { ownerId: 'o1', trigger: 'SCHEDULE', weekKey: '2026-10-30' },
        { ownerId: 'a1', trigger: 'SCHEDULE', weekKey: '2026-10-30' },
      ],
      skipDuplicates: true,
    });
  });

  it('цель занята, пока рекомендация открыта, отклонена или применена за 30 дней', async () => {
    const now = new Date('2026-10-30T04:00:00Z');
    const rows = [
      { fingerprint: 'f1', action: 'SET_ROUTINE_CAP', payload: { targetId: 'r1' }, status: 'NEW', decidedAt: null },
      { fingerprint: 'f2', action: 'DISABLE_SKILL', payload: { targetId: 's1' }, status: 'DISMISSED', decidedAt: new Date('2026-01-01') },
      { fingerprint: 'f3', action: 'REVISE_SKILL', payload: { targetId: 's2' }, status: 'APPLIED', decidedAt: new Date('2026-10-20') },
      { fingerprint: 'f4', action: 'REVISE_SKILL', payload: { targetId: 's3' }, status: 'APPLIED', decidedAt: new Date('2026-08-01') },
      { fingerprint: 'f5', action: 'DEV_TASK', payload: { targetId: null }, status: 'APPLIED', decidedAt: new Date('2026-10-20') },
    ];
    const prisma = { recommendation: { findMany: () => Promise.resolve(rows) } };
    const keys = await new RecommendationGenerationService(prisma as never, {} as never).knownKeys('o1', now);
    expect([...keys].sort()).toEqual(
      ['f1', 'f2', 'f3', 'f4', 'f5', recoTargetKey('SET_ROUTINE_CAP', 'r1')!, recoTargetKey('DISABLE_SKILL', 's1')!, recoTargetKey('REVISE_SKILL', 's2')!].sort(),
    );
  });
});

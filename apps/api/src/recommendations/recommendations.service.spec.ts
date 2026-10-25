import { RecommendationsService } from './recommendations.service';
import type { RecoPayload } from './recommendation-prompt';

// Применение рекомендаций — через сервисы-заглушки, без БД.

const user = { id: 'u1', email: 'z@t.kz', role: 'OWNER' as const };
const empty: RecoPayload = { targetId: null, text: null, memoryKind: null, model: null, weeklyTokenCap: null, routine: null };

type Row = Record<string, unknown> & { id: string; status: string; decidedAt: Date | null };

function reco(id: string, action: string, payload: Partial<RecoPayload>, extra: Partial<Row> = {}): Row {
  return {
    id,
    ownerId: 'u1',
    area: 'ROUTINES',
    action,
    title: `Рек ${id}`,
    benefit: 'Польза',
    plan: 'План',
    effort: 'LOW',
    priority: 1,
    tokenSaving: null,
    payload: { ...empty, ...payload },
    status: 'NEW',
    result: null,
    error: null,
    createdAt: new Date('2026-10-30T04:00:00Z'),
    decidedAt: null,
    ...extra,
  };
}

function setup(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const calls: string[] = [];
  const audit: string[] = [];
  const prisma = {
    recommendation: {
      findFirst: (a: { where: { id: string; ownerId: string } }) => {
        const r = byId.get(a.where.id);
        return Promise.resolve(r && r.ownerId === a.where.ownerId ? r : null);
      },
      updateMany: (a: { where: { id: string; status: { in: string[] }; decidedAt: null }; data: Partial<Row> }) => {
        const r = byId.get(a.where.id);
        if (!r || !a.where.status.in.includes(r.status) || r.decidedAt !== null) return Promise.resolve({ count: 0 });
        Object.assign(r, a.data);
        return Promise.resolve({ count: 1 });
      },
      update: (a: { where: { id: string }; data: Partial<Row> }) => {
        const r = byId.get(a.where.id)!;
        Object.assign(r, a.data);
        return Promise.resolve(r);
      },
    },
  };
  const routines = {
    proposeDraft: (_u: string, input: { title: string; skillId: string | null; prompt: string | null }, key: string) => {
      calls.push(`draft:${input.title}:${input.skillId ?? '-'}:${input.prompt ?? '-'}:${key}`);
      return Promise.resolve({ id: 'rt1', title: input.title, state: 'DRAFT' });
    },
    update: (_u: string, id: string, patch: { weeklyTokenCap: number }) => {
      calls.push(`cap:${id}:${patch.weeklyTokenCap}`);
      return Promise.resolve({ id, title: 'Регламент' });
    },
  };
  const skills = {
    proposeRevision: (_u: string, id: string, text: string) => {
      calls.push(`revision:${id}:${text}`);
      return Promise.resolve({ id: 'rev1', skillId: id });
    },
    update: (_u: string, id: string, input: Record<string, unknown>) => {
      calls.push(`skill:${id}:${JSON.stringify(input)}`);
      return Promise.resolve({ id, slug: 'отчёт' });
    },
  };
  const memory = {
    remember: (_u: string, input: { kind: string; text: string }, key: string) => {
      calls.push(`remember:${input.kind}:${input.text}:${key}`);
      return Promise.resolve({ item: { id: 'mem1', text: input.text } });
    },
    forget: (_u: string, id: string) => {
      calls.push(`forget:${id}`);
      return Promise.resolve({ id, text: 'старое' });
    },
  };
  const tasks = {
    create: (dto: { title: string; description: string; assigneeId: string }) => {
      calls.push(`task:${dto.title}:${dto.assigneeId}`);
      return Promise.resolve({ id: 't1', title: dto.title });
    },
  };
  const auditService = {
    log: (_a: string, action: string, _t: string, id: string) => {
      audit.push(`${action}:${id}`);
      return Promise.resolve();
    },
  };
  const service = new RecommendationsService(prisma as never, auditService as never, memory as never, routines as never, skills as never, tasks as never);
  return { service, byId, calls, audit };
}

describe('рекомендации: применение', () => {
  it('«создать регламент» — черновик с ключом рекомендации', async () => {
    const routine = { title: 'Письма', prompt: 'Найди письма без ответа', days: [1], time: '09:00', mode: 'PASSIVE' as const, channel: 'TELEGRAM' as const };
    const { service, byId, calls, audit } = setup([reco('a', 'CREATE_ROUTINE', { routine })]);
    const [out] = await service.apply(user, ['a']);
    expect(calls).toEqual(['draft:Письма:-:Найди письма без ответа:reco:a']);
    expect(out.status).toBe('APPLIED');
    expect(out.result).toEqual({ kind: 'routine', id: 'rt1', label: 'Черновик регламента «Письма»' });
    expect(byId.get('a')!.decidedAt).toBeInstanceOf(Date);
    expect(audit).toEqual(['RECOMMENDATION_APPLY:a']);
  });

  it('каждое действие — через свой сервис', async () => {
    const { service, calls } = setup([
      reco('b', 'REVISE_SKILL', { targetId: 's1', text: 'Новая инструкция' }),
      reco('c', 'DOWNGRADE_SKILL_MODEL', { targetId: 's1', model: 'SONNET' }),
      reco('d', 'DISABLE_SKILL', { targetId: 's2' }),
      reco('e', 'ADD_MEMORY', { memoryKind: 'RULE', text: 'Отчёты по пятницам' }),
      reco('f', 'ARCHIVE_MEMORY', { targetId: 'm1' }),
      reco('g', 'SET_ROUTINE_CAP', { targetId: 'r1', weeklyTokenCap: 50000 }),
      reco('h', 'DEV_TASK', { text: 'Экран отчётов' }),
    ]);
    const out = await service.apply(user, ['b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(out.every((r) => r.status === 'APPLIED')).toBe(true);
    expect(calls).toEqual([
      'revision:s1:Новая инструкция',
      'skill:s1:{"model":"SONNET"}',
      'skill:s2:{"enabled":false}',
      'remember:RULE:Отчёты по пятницам:reco:e',
      'forget:m1',
      'cap:r1:50000',
      'task:Доработка: Рек h:u1',
    ]);
  });

  it('ошибка одной не останавливает остальные и не помечает применённой', async () => {
    const { service, byId } = setup([reco('x', 'DISABLE_SKILL', {}), reco('y', 'ARCHIVE_MEMORY', { targetId: 'm1' })]);
    const out = await service.apply(user, ['x', 'y']);
    expect(out.map((r) => r.status)).toEqual(['NEW', 'APPLIED']);
    expect(out[0].error).toBe('Не указана цель');
    expect(byId.get('x')!.decidedAt).toBeNull();
  });

  it('повторное применение и отклонённая — без действий', async () => {
    const { service, calls } = setup([reco('a', 'DEV_TASK', { text: 'x' }), reco('z', 'DEV_TASK', { text: 'x' }, { status: 'DISMISSED', decidedAt: new Date() })]);
    await service.apply(user, ['a', 'a']);
    await service.apply(user, ['a', 'z']);
    expect(calls).toEqual(['task:Доработка: Рек a:u1']);
  });

  it('применённую нельзя вернуть в корзину; отклонение — в аудит', async () => {
    const { service, audit } = setup([reco('a', 'DEV_TASK', { text: 'x' }, { status: 'APPLIED' }), reco('b', 'DEV_TASK', { text: 'x' })]);
    await expect(service.setStatus('u1', 'a', 'IN_CART')).rejects.toThrow('уже применена');
    const out = await service.setStatus('u1', 'b', 'DISMISSED');
    expect(out.status).toBe('DISMISSED');
    expect(audit).toEqual(['RECOMMENDATION_DISMISS:b']);
  });

  it('чужая рекомендация — 404', async () => {
    const { service } = setup([reco('a', 'DEV_TASK', { text: 'x' }, { ownerId: 'u2' })]);
    await expect(service.setStatus('u1', 'a', 'IN_CART')).rejects.toThrow('не найдена');
  });
});

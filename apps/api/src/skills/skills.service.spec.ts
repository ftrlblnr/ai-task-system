import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SkillsService } from './skills.service';

const baseSkill = {
  id: 's1',
  ownerId: null,
  slug: 'день',
  title: 'Мой день',
  description: 'd',
  kind: 'ACTION',
  instructions: 'Шаги',
  model: 'HAIKU',
  effort: 'LOW',
  allowedTools: ['get_tasks'],
  output: 'TELEGRAM',
  enabled: true,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function make(overrides: Record<string, unknown> = {}) {
  const tx = {
    skill: { update: jest.fn().mockResolvedValue(baseSkill), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: jest.fn().mockResolvedValue(baseSkill) },
    skillRevision: { create: jest.fn(), update: jest.fn() },
  };
  const prisma = {
    skill: { findFirst: jest.fn().mockResolvedValue(baseSkill), findMany: jest.fn().mockResolvedValue([baseSkill]), delete: jest.fn() },
    skillRun: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn(), findUnique: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    skillRevision: { findUnique: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
    $transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    ...overrides,
  };
  return { service: new SkillsService(prisma as never, {} as never), prisma, tx };
}

const owner = { id: 'u1', email: 'o@x.kz', role: 'OWNER' as const };

describe('SkillsService', () => {
  it('навык вызывает только руководство — сотруднику команда остаётся текстом', async () => {
    const { service, prisma } = make();
    expect(await service.resolveInvocation({ ...owner, role: 'EMPLOYEE' }, '/день')).toBeNull();
    expect(prisma.skill.findMany).not.toHaveBeenCalled();
  });

  it('свой навык важнее общего с тем же slug', async () => {
    const { service, prisma } = make();
    prisma.skill.findMany.mockResolvedValue([baseSkill, { ...baseSkill, id: 'own', ownerId: 'u1', instructions: 'Моё' }]);
    const r = await service.resolveInvocation(owner, '/день только встречи');
    expect(r?.skill.id).toBe('own');
    expect(r?.rest).toBe('только встречи');
    expect(prisma.skill.findMany.mock.calls[0][0].where).toMatchObject({ slug: 'день', enabled: true });
  });

  it('неизвестная команда — обычное сообщение', async () => {
    const { service, prisma } = make();
    prisma.skill.findMany.mockResolvedValue([]);
    expect(await service.resolveInvocation(owner, '/нет-такого')).toBeNull();
  });

  describe('toneFor — стиль сотрудника для черновиков почты', () => {
    const tone = { ...baseSkill, id: 'tone-sys', slug: 'тон', instructions: 'Коротко, на «вы».', version: 4 };

    it('личный /тон важнее общего; блок и версия — личного', async () => {
      const { service, prisma } = make();
      prisma.skill.findMany.mockResolvedValue([tone, { ...tone, id: 'tone-own', ownerId: 'leader', instructions: 'Мой стиль', version: 2 }]);
      const r = await service.toneFor('leader');
      expect(r).toMatchObject({ version: 2, skillId: 'tone-own' });
      expect(r.block).toContain('Мой стиль');
      expect(prisma.skill.findMany.mock.calls[0][0].where).toMatchObject({ slug: 'тон', enabled: true, OR: [{ ownerId: null }, { ownerId: 'leader' }] });
    });

    it('чужой личный /тон не берётся — только общий', async () => {
      const { service, prisma } = make();
      prisma.skill.findMany.mockResolvedValue([{ ...tone, id: 'tone-other', ownerId: 'someone' }, tone]);
      expect((await service.toneFor('leader')).skillId).toBe('tone-sys');
    });

    it('заглушка «пока пусто» — стиля нет: блок и версия null, ссылка на навык остаётся', async () => {
      const { service, prisma } = make();
      prisma.skill.findMany.mockResolvedValue([{ ...tone, instructions: 'Пока пусто. Соберите стиль из отправленных писем на странице навыка.' }]);
      expect(await service.toneFor('leader')).toEqual({ block: null, version: null, skillId: 'tone-sys' });
    });

    it('навыка нет или он в архиве — всё null', async () => {
      const { service, prisma } = make();
      prisma.skill.findMany.mockResolvedValue([]);
      expect(await service.toneFor('leader')).toEqual({ block: null, version: null, skillId: null });
    });
  });

  it('правка инструкции — новая версия и строка истории; без правки — без истории', async () => {
    const { service, tx } = make();
    await service.update('u1', 's1', { instructions: 'Новые шаги' });
    expect(tx.skill.update.mock.calls[0][0].data).toMatchObject({ instructions: 'Новые шаги', version: { increment: 1 } });
    expect(tx.skillRevision.create.mock.calls[0][0].data).toMatchObject({ source: 'MANUAL', status: 'APPLIED', baseVersion: 1 });

    const second = make();
    await second.service.update('u1', 's1', { instructions: 'Шаги', title: 'Мой день!' });
    expect(second.tx.skillRevision.create).not.toHaveBeenCalled();
    expect(second.tx.skill.update.mock.calls[0][0].data.version).toBeUndefined();
  });

  it('предложение не применяется, если навык успели изменить', async () => {
    const { service, prisma, tx } = make();
    prisma.skillRevision.findUnique.mockResolvedValue({ id: 'r1', skillId: 's1', status: 'PROPOSED', instructions: 'Лучше', baseVersion: 1 });
    tx.skill.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.applyRevision('u1', 'r1')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.skillRevision.update).not.toHaveBeenCalled();
  });

  it('применение — по версии, статус APPLIED', async () => {
    const { service, prisma, tx } = make();
    prisma.skillRevision.findUnique.mockResolvedValue({ id: 'r1', skillId: 's1', status: 'PROPOSED', instructions: 'Лучше', baseVersion: 1 });
    await service.applyRevision('u1', 'r1');
    expect(tx.skill.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 's1', version: 1 }, data: { instructions: 'Лучше' } });
    expect(tx.skillRevision.update.mock.calls[0][0].data.status).toBe('APPLIED');
  });

  it('отзыв на чужой запуск — 404', async () => {
    const { service, prisma } = make();
    prisma.skillRun.findFirst.mockResolvedValue(null);
    await expect(service.feedback('u1', 'run-of-other', 'DOWN', 'плохо')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.skillRun.findFirst.mock.calls[0][0].where).toEqual({ id: 'run-of-other', ownerId: 'u1' });
  });

  it('повтор ▶ с тем же clientRequestId — тот же запуск', async () => {
    const { service, prisma } = make();
    prisma.skillRun.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    prisma.skillRun.findUnique.mockResolvedValue({ id: 'run1' });
    await expect(service.enqueueRun('u1', 's1', '', 'req-1')).resolves.toEqual({ id: 'run1' });
    expect(prisma.skillRun.findUnique).toHaveBeenCalledWith({ where: { idempotencyKey: 'button:u1:req-1' } });
  });

  it('общий навык не удаляется; «из писем» — только тон; обучение без отзывов — нельзя', async () => {
    const { service } = make();
    await expect(service.remove('u1', 's1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.requestRevision('u1', 's1', 'SENT_MAIL')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.requestRevision('u1', 's1', 'FEEDBACK')).rejects.toBeInstanceOf(BadRequestException);
  });
});

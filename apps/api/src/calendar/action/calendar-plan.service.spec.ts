import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CalendarPlanService } from './calendar-plan.service';
import { FakeCalendarActionPrisma } from './test-support/fake-calendar-action-prisma';
import { computeCalendarActionPayloadHash } from './calendar-action-rules';

describe('CalendarPlanService (ТЗ разд. 7/20)', () => {
  let prisma: FakeCalendarActionPrisma;
  let service: CalendarPlanService;

  beforeEach(() => {
    prisma = new FakeCalendarActionPrisma();
    service = new CalendarPlanService(prisma as never);
  });

  it('план без действий — DRAFT', async () => {
    const plan = await service.createPlan('owner-1', 'собери закупки и юриста');
    expect(plan.status).toBe('DRAFT');
  });

  it('план с действиями — NEEDS_APPROVAL', async () => {
    const plan = await service.createPlan('owner-1', 'создай встречу', [
      { localId: 'a', type: 'CREATE_EVENT', parameters: { title: 'Встреча' } },
    ]);
    expect(plan.status).toBe('NEEDS_APPROVAL');
    const actions = await service.listActions('owner-1', plan.id);
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe('PENDING');
  });

  it('dependsOnLocalIds разворачивается в настоящие id действий', async () => {
    const plan = await service.createPlan('owner-1', 'x', [
      { localId: 'create', type: 'CREATE_EVENT', parameters: { title: 'Встреча' } },
      { localId: 'invite', type: 'UPDATE_EVENT', parameters: {}, dependsOnLocalIds: ['create'] },
    ]);
    const actions = await service.listActions('owner-1', plan.id);
    const create = actions.find((a) => a.type === 'CREATE_EVENT')!;
    const invite = actions.find((a) => a.type === 'UPDATE_EVENT')!;
    expect(invite.dependsOnActionIds).toEqual([create.id]);
  });

  it('чужой план — 404', async () => {
    const plan = await service.createPlan('owner-1', 'x');
    await expect(service.getPlanOrThrow('owner-2', plan.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('patchAction (раздел 14 ТЗ)', () => {
    it('правка параметров пересчитывает payloadHash и снимает согласие', async () => {
      const plan = await service.createPlan('owner-1', 'x', [{ localId: 'a', type: 'CREATE_EVENT', parameters: { title: 'A' } }]);
      const [action] = await service.listActions('owner-1', plan.id);
      prisma.actions[0].authorizationId = 'auth-1';
      prisma.actions[0].status = 'FAILED';

      const patched = await service.patchAction('owner-1', plan.id, action.id, { version: action.version, parameters: { title: 'B' } });
      expect(patched.payloadHash).toBe(computeCalendarActionPayloadHash('CREATE_EVENT', { title: 'B' }));
      expect(patched.authorizationId).toBeNull();
      expect(patched.status).toBe('PENDING');
    });

    it('неверная version — 409', async () => {
      const plan = await service.createPlan('owner-1', 'x', [{ localId: 'a', type: 'CREATE_EVENT', parameters: { title: 'A' } }]);
      const [action] = await service.listActions('owner-1', plan.id);
      await expect(service.patchAction('owner-1', plan.id, action.id, { version: 999 })).rejects.toBeInstanceOf(ConflictException);
    });

    it('действие в RUNNING — запрещено', async () => {
      const plan = await service.createPlan('owner-1', 'x', [{ localId: 'a', type: 'CREATE_EVENT', parameters: { title: 'A' } }]);
      prisma.actions[0].status = 'RUNNING';
      await expect(service.patchAction('owner-1', plan.id, prisma.actions[0].id, { version: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

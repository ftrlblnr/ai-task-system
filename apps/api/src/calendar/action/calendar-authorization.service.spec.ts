import { ConflictException, NotFoundException } from '@nestjs/common';
import { CalendarAuthorizationService } from './calendar-authorization.service';
import { CalendarActionExecutionService } from './calendar-action-execution.service';
import { CalendarActionExecutorRegistry } from './calendar-action-executor';
import { CalendarPlanService } from './calendar-plan.service';
import { FakeCalendarActionPrisma } from './test-support/fake-calendar-action-prisma';

describe('CalendarAuthorizationService (ТЗ разд. 7/8/17)', () => {
  let prisma: FakeCalendarActionPrisma;
  let plans: CalendarPlanService;
  let authorizations: CalendarAuthorizationService;

  beforeEach(() => {
    prisma = new FakeCalendarActionPrisma();
    plans = new CalendarPlanService(prisma as never);
    const execution = new CalendarActionExecutionService(prisma as never, new CalendarActionExecutorRegistry());
    jest.spyOn(execution, 'start').mockResolvedValue(undefined);
    authorizations = new CalendarAuthorizationService(prisma as never, execution);
  });

  async function planWithOneAction() {
    const plan = await plans.createPlan('owner-1', 'создай встречу', [{ localId: 'a', type: 'CREATE_EVENT', parameters: { title: 'Встреча' } }]);
    const [action] = await plans.listActions('owner-1', plan.id);
    return { plan, action };
  }

  it('согласует действие: переходит в APPROVED, план в APPROVED, создаётся исполнение', async () => {
    const { plan, action } = await planWithOneAction();
    const result = await authorizations.approve('owner-1', plan.id, { planVersion: plan.version, actionIds: [action.id] });
    expect(prisma.actions[0].authorizationId).toBe(result.authorization.id);
    expect(prisma.plans[0].status).toBe('APPROVED');
    expect(prisma.executions).toHaveLength(1);
  });

  it('несовпадение planVersion — 409', async () => {
    const { plan, action } = await planWithOneAction();
    await expect(authorizations.approve('owner-1', plan.id, { planVersion: plan.version + 1, actionIds: [action.id] })).rejects.toBeInstanceOf(ConflictException);
  });

  it('чужой план — 404', async () => {
    const { plan, action } = await planWithOneAction();
    await expect(authorizations.approve('owner-2', plan.id, { planVersion: plan.version, actionIds: [action.id] })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('повторное согласование уже согласованного действия — 409', async () => {
    const { plan, action } = await planWithOneAction();
    await authorizations.approve('owner-1', plan.id, { planVersion: plan.version, actionIds: [action.id] });
    // plan.version в памяти не обновлён у вызывающего — читаем актуальный из fake.
    await expect(
      authorizations.approve('owner-1', plan.id, { planVersion: prisma.plans[0].version, actionIds: [action.id] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('зависимость действия, не входящая в согласие и не исполненная — UNSATISFIED_DEPENDENCY', async () => {
    const plan = await plans.createPlan('owner-1', 'x', [
      { localId: 'create', type: 'CREATE_EVENT', parameters: { title: 'Встреча' } },
      { localId: 'update', type: 'UPDATE_EVENT', parameters: { title: 'Новое' }, dependsOnLocalIds: ['create'] },
    ]);
    const actions = await plans.listActions('owner-1', plan.id);
    const update = actions.find((a) => a.type === 'UPDATE_EVENT')!;
    await expect(authorizations.approve('owner-1', plan.id, { planVersion: plan.version, actionIds: [update.id] })).rejects.toBeInstanceOf(ConflictException);
  });

  it('действие и его зависимость согласуются вместе — проходит', async () => {
    const plan = await plans.createPlan('owner-1', 'x', [
      { localId: 'create', type: 'CREATE_EVENT', parameters: { title: 'Встреча' } },
      { localId: 'update', type: 'UPDATE_EVENT', parameters: { title: 'Новое' }, dependsOnLocalIds: ['create'] },
    ]);
    const actions = await plans.listActions('owner-1', plan.id);
    await expect(
      authorizations.approve('owner-1', plan.id, { planVersion: plan.version, actionIds: actions.map((a) => a.id) }),
    ).resolves.toBeDefined();
  });
});

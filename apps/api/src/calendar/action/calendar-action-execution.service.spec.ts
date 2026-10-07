import { ConflictException, NotFoundException } from '@nestjs/common';
import { CalendarActionExecutionService } from './calendar-action-execution.service';
import { CalendarActionExecutor, CalendarActionExecutorRegistry } from './calendar-action-executor';
import { CalendarPlanService } from './calendar-plan.service';
import { FakeCalendarActionPrisma } from './test-support/fake-calendar-action-prisma';
import { computeCalendarSnapshotHash } from './calendar-action-rules';

function fakeExecutor(outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED_CHANGED' = 'SUCCEEDED'): CalendarActionExecutor {
  return { execute: jest.fn().mockResolvedValue({ outcome }) };
}

describe('CalendarActionExecutionService (ТЗ разд. 17/18/21)', () => {
  let prisma: FakeCalendarActionPrisma;
  let plans: CalendarPlanService;
  let registry: CalendarActionExecutorRegistry;
  let execution: CalendarActionExecutionService;

  beforeEach(() => {
    prisma = new FakeCalendarActionPrisma();
    plans = new CalendarPlanService(prisma as never);
    registry = new CalendarActionExecutorRegistry();
    execution = new CalendarActionExecutionService(prisma as never, registry);
  });

  async function approvedSingleAction(type: 'CREATE_EVENT' | 'UPDATE_EVENT' = 'CREATE_EVENT', dependsOnLocalIds?: string[], extra: Parameters<typeof plans.createPlan>[2] = []) {
    const plan = await plans.createPlan('owner-1', 'x', [...extra, { localId: 'main', type, parameters: {}, dependsOnLocalIds }]);
    const actions = prisma.actions.filter((a) => a.planId === plan.id);
    const authorization = await prisma.calendarAuthorization.create({
      data: {
        actorId: 'owner-1',
        planId: plan.id,
        planVersion: plan.version,
        actionIds: actions.map((a) => a.id),
        immutableActionSnapshot: actions,
        payloadHash: computeCalendarSnapshotHash(actions),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await prisma.calendarAction.updateMany({ where: { id: { in: actions.map((a) => a.id) } }, data: { authorizationId: authorization.id } });
    const exec = await prisma.calendarActionExecution.create({ data: { authorizationId: authorization.id } });
    return { plan, actions, authorization, exec };
  }

  it('успешное исполнение переводит действие в SUCCEEDED, исполнение в DONE, план в SUCCEEDED', async () => {
    registry.register('CREATE_EVENT', fakeExecutor('SUCCEEDED'));
    const { actions, exec } = await approvedSingleAction('CREATE_EVENT');
    await execution.start(exec.id);
    const main = prisma.actions.find((a) => a.id === actions.find((it) => it.type === 'CREATE_EVENT')!.id)!;
    expect(main.status).toBe('SUCCEEDED');
    expect(prisma.executions[0].state).toBe('DONE');
    expect(prisma.plans[0].status).toBe('SUCCEEDED');
    expect(prisma.attempts).toHaveLength(1);
  });

  it('нет зарегистрированного исполнителя — действие FAILED с errorCode NOT_IMPLEMENTED, план FAILED', async () => {
    const { exec } = await approvedSingleAction('CREATE_EVENT');
    await execution.start(exec.id);
    expect(prisma.actions[0].status).toBe('FAILED');
    expect(prisma.attempts[0].errorCode).toBe('NOT_IMPLEMENTED');
    expect(prisma.plans[0].status).toBe('FAILED');
  });

  it('повторный start() на уже выполняющемся исполнении — не исполняет дважды', async () => {
    registry.register('CREATE_EVENT', fakeExecutor('SUCCEEDED'));
    const { exec } = await approvedSingleAction('CREATE_EVENT');
    await Promise.all([execution.start(exec.id), execution.start(exec.id)]);
    expect(prisma.attempts).toHaveLength(1);
  });

  it('зависимость не выполнена в этом согласии — зависящее действие BLOCKED_DEPENDENCY', async () => {
    const createExecutor = fakeExecutor('FAILED');
    registry.register('CREATE_EVENT', createExecutor);
    const updateExecutor = fakeExecutor('SUCCEEDED');
    registry.register('UPDATE_EVENT', updateExecutor);
    const { actions, exec } = await approvedSingleAction('UPDATE_EVENT', ['create'], [
      { localId: 'create', type: 'CREATE_EVENT', parameters: {} },
    ]);
    await execution.start(exec.id);
    const update = prisma.actions.find((a) => a.id === actions.find((it) => it.type === 'UPDATE_EVENT')!.id)!;
    expect(update.status).toBe('BLOCKED_DEPENDENCY');
    expect(updateExecutor.execute).not.toHaveBeenCalled();
  });

  it('частичный результат — план PARTIAL, не SUCCEEDED/FAILED', async () => {
    const createExecutor = fakeExecutor('SUCCEEDED');
    registry.register('CREATE_EVENT', createExecutor);
    registry.register('UPDATE_EVENT', fakeExecutor('FAILED'));
    const { exec } = await approvedSingleAction('UPDATE_EVENT', undefined, [{ localId: 'create', type: 'CREATE_EVENT', parameters: {} }]);
    await execution.start(exec.id);
    expect(prisma.plans[0].status).toBe('PARTIAL');
  });

  it('retry() требует завершённого исполнения', async () => {
    registry.register('CREATE_EVENT', fakeExecutor('SUCCEEDED'));
    const { exec } = await approvedSingleAction('CREATE_EVENT');
    await prisma.calendarActionExecution.update({ where: { id: exec.id }, data: { state: 'RUNNING' } });
    await expect(execution.retry('owner-1', exec.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('retry() переисполняет FAILED действие и доводит до SUCCEEDED', async () => {
    const flaky = { execute: jest.fn().mockResolvedValueOnce({ outcome: 'FAILED' as const }).mockResolvedValueOnce({ outcome: 'SUCCEEDED' as const }) };
    registry.register('CREATE_EVENT', flaky);
    const { actions, exec } = await approvedSingleAction('CREATE_EVENT');
    await execution.start(exec.id);
    expect(prisma.actions.find((a) => a.id === actions[0].id)!.status).toBe('FAILED');

    await execution.retry('owner-1', exec.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(prisma.actions.find((a) => a.id === actions[0].id)!.status).toBe('SUCCEEDED');
    expect(flaky.execute).toHaveBeenCalledTimes(2);
  });

  it('чужое исполнение — 404', async () => {
    registry.register('CREATE_EVENT', fakeExecutor('SUCCEEDED'));
    const { exec } = await approvedSingleAction('CREATE_EVENT');
    await expect(execution.getExecutionOrThrow('owner-2', exec.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

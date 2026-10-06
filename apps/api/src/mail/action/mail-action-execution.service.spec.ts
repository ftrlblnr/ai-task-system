import { ConflictException, NotFoundException } from '@nestjs/common';
import { MailActionExecutionService } from './mail-action-execution.service';
import { MailActionExecutor, MailActionExecutorRegistry } from './mail-action-executor';
import { MailActionPlanService } from './mail-action-plan.service';
import { FakeMailActionPrisma } from './test-support/fake-mail-action-prisma';
import { computeSnapshotHash } from './mail-action-rules';

function fakeExecutor(outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED_CHANGED' = 'SUCCEEDED'): MailActionExecutor {
  return { execute: jest.fn().mockResolvedValue({ outcome }) };
}

// Исполнители в этих тестах — моки (fakeExecutor выше), ни один не
// обращается к ctx.session реально, поэтому фейковая сессия здесь — просто
// заглушка с close().
const fakeSessions = { openSession: jest.fn().mockResolvedValue({ close: jest.fn().mockResolvedValue(undefined) }) };

describe('MailActionExecutionService (ТЗ разд. 14-16)', () => {
  let prisma: FakeMailActionPrisma;
  let plans: MailActionPlanService;
  let registry: MailActionExecutorRegistry;
  let execution: MailActionExecutionService;

  beforeEach(() => {
    prisma = new FakeMailActionPrisma();
    plans = new MailActionPlanService(prisma as never);
    registry = new MailActionExecutorRegistry();
    execution = new MailActionExecutionService(prisma as never, registry, fakeSessions as never);
  });

  async function approvedSingleItem(type: 'ARCHIVE' | 'MOVE' | 'CREATE_FOLDER' = 'ARCHIVE', dependsOnLocalIds?: string[], extraCandidates: Parameters<typeof plans.attachAnalysisResult>[1] = []) {
    const plan = await plans.createPlan('owner', 'mbx-1', { requestText: 'x' });
    await plans.attachAnalysisResult(plan.id, [
      ...extraCandidates,
      { localId: 'main', type, stableObjectIds: ['msg-1'], sourceLocators: {}, reason: 'r', parameters: {}, dependsOnLocalIds },
    ]);
    const items = prisma.items.filter((i) => i.planId === plan.id);
    const approval = await prisma.mailActionApproval.create({
      data: {
        actorId: 'owner',
        planId: plan.id,
        planVersion: plan.version,
        groupType: 'MAILBOX_ORDER',
        itemIds: items.map((i) => i.id),
        immutableActionSnapshot: items,
        payloadHash: computeSnapshotHash(items),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await prisma.mailActionItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { approvalId: approval.id, status: 'APPROVED' } });
    const exec = await prisma.mailActionExecution.create({ data: { approvalId: approval.id } });
    return { plan, items, approval, exec };
  }

  it('успешное исполнение переводит пункт в SUCCEEDED, исполнение в DONE', async () => {
    registry.register('ARCHIVE', fakeExecutor('SUCCEEDED'));
    const { items, exec } = await approvedSingleItem('ARCHIVE');
    await execution.start(exec.id);
    const item = prisma.items.find((i) => i.id === items.find((it) => it.type === 'ARCHIVE')!.id)!;
    expect(item.status).toBe('SUCCEEDED');
    expect(prisma.executions[0].state).toBe('DONE');
    expect(prisma.attempts).toHaveLength(1);
    expect(prisma.attempts[0].outcome).toBe('SUCCEEDED');
  });

  it('не удалось открыть сессию ящика — все пункты FAILED, исполнение DONE', async () => {
    registry.register('ARCHIVE', fakeExecutor('SUCCEEDED'));
    fakeSessions.openSession.mockRejectedValueOnce(new Error('IMAP_DISABLED'));
    const { items, exec } = await approvedSingleItem('ARCHIVE');
    await execution.start(exec.id);
    const item = prisma.items.find((i) => i.id === items[0].id)!;
    expect(item.status).toBe('FAILED');
    expect(prisma.executions[0].state).toBe('DONE');
    expect(prisma.attempts).toHaveLength(0);
  });

  it('нет зарегистрированного исполнителя — пункт FAILED с errorCode NOT_IMPLEMENTED', async () => {
    const { items, exec } = await approvedSingleItem('ARCHIVE');
    await execution.start(exec.id);
    const item = prisma.items.find((i) => i.id === items[0].id)!;
    expect(item.status).toBe('FAILED');
    expect(prisma.attempts[0].errorCode).toBe('NOT_IMPLEMENTED');
  });

  it('повторный start() на уже выполняющемся исполнении — не исполняет дважды', async () => {
    registry.register('ARCHIVE', fakeExecutor('SUCCEEDED'));
    const { exec } = await approvedSingleItem('ARCHIVE');
    await Promise.all([execution.start(exec.id), execution.start(exec.id)]);
    expect(prisma.attempts).toHaveLength(1);
  });

  it('зависимость не выполнена в этом согласии — зависящий пункт BLOCKED_DEPENDENCY, не вызывает исполнитель', async () => {
    const folderExecutor = fakeExecutor('FAILED');
    registry.register('CREATE_FOLDER', folderExecutor);
    const moveExecutor = fakeExecutor('SUCCEEDED');
    registry.register('MOVE', moveExecutor);
    const { items, exec } = await approvedSingleItem('MOVE', ['folder'], [
      { localId: 'folder', type: 'CREATE_FOLDER', stableObjectIds: [], sourceLocators: {}, reason: 'r', parameters: {} },
    ]);
    await execution.start(exec.id);
    const move = prisma.items.find((i) => i.id === items.find((it) => it.type === 'MOVE')!.id)!;
    expect(move.status).toBe('BLOCKED_DEPENDENCY');
    expect(moveExecutor.execute).not.toHaveBeenCalled();
  });

  it('зависимость выполнена успешно — зависящий пункт выполняется следом', async () => {
    registry.register('CREATE_FOLDER', fakeExecutor('SUCCEEDED'));
    registry.register('MOVE', fakeExecutor('SUCCEEDED'));
    const { items, exec } = await approvedSingleItem('MOVE', ['folder'], [
      { localId: 'folder', type: 'CREATE_FOLDER', stableObjectIds: [], sourceLocators: {}, reason: 'r', parameters: {} },
    ]);
    await execution.start(exec.id);
    const move = prisma.items.find((i) => i.id === items.find((it) => it.type === 'MOVE')!.id)!;
    expect(move.status).toBe('SUCCEEDED');
  });

  it('stop() взводит cancelRequestedAt, следующий пункт не исполняется', async () => {
    let execId = '';
    const executor: MailActionExecutor = {
      execute: jest.fn().mockImplementation(async () => {
        await execution.stop('owner', execId);
        return { outcome: 'SUCCEEDED' as const };
      }),
    };
    registry.register('CREATE_FOLDER', executor);
    registry.register('MOVE', fakeExecutor('SUCCEEDED'));
    const setup = await approvedSingleItem('MOVE', undefined, [
      { localId: 'folder', type: 'CREATE_FOLDER', stableObjectIds: [], sourceLocators: {}, reason: 'r', parameters: {} },
    ]);
    execId = setup.exec.id;
    await execution.start(setup.exec.id);
    expect(prisma.executions[0].state).toBe('STOPPED');
    const move = prisma.items.find((i) => i.type === 'MOVE')!;
    expect(move.status).toBe('QUEUED');
  });

  it('retry() требует завершённого исполнения', async () => {
    registry.register('ARCHIVE', fakeExecutor('SUCCEEDED'));
    const { exec } = await approvedSingleItem('ARCHIVE');
    await prisma.mailActionExecution.update({ where: { id: exec.id }, data: { state: 'RUNNING' } });
    await expect(execution.retry('owner', exec.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('retry() без FAILED/UNKNOWN пунктов — отказ', async () => {
    registry.register('ARCHIVE', fakeExecutor('SUCCEEDED'));
    const { exec } = await approvedSingleItem('ARCHIVE');
    await execution.start(exec.id);
    await expect(execution.retry('owner', exec.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('retry() переисполняет FAILED пункт и доводит до SUCCEEDED', async () => {
    const flaky = { execute: jest.fn().mockResolvedValueOnce({ outcome: 'FAILED' as const }).mockResolvedValueOnce({ outcome: 'SUCCEEDED' as const }) };
    registry.register('ARCHIVE', flaky);
    const { items, exec } = await approvedSingleItem('ARCHIVE');
    await execution.start(exec.id);
    expect(prisma.items.find((i) => i.id === items[0].id)!.status).toBe('FAILED');

    // retry() запускает повторное исполнение fire-and-forget (как
    // approveGroup) — HTTP-ответ не ждёт его завершения. Дожидаемся
    // отдельно, чтобы проверить итог.
    await execution.retry('owner', exec.id);
    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.items.find((i) => i.id === items[0].id)!.status).toBe('SUCCEEDED');
    expect(flaky.execute).toHaveBeenCalledTimes(2);
  });

  it('чужое исполнение — 404', async () => {
    registry.register('ARCHIVE', fakeExecutor('SUCCEEDED'));
    const { exec } = await approvedSingleItem('ARCHIVE');
    await expect(execution.getExecutionOrThrow('intruder', exec.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});

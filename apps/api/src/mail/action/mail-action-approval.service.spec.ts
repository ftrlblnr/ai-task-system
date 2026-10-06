import { ConflictException, NotFoundException } from '@nestjs/common';
import { MailActionApprovalService } from './mail-action-approval.service';
import { MailActionExecutionService } from './mail-action-execution.service';
import { MailActionExecutorRegistry } from './mail-action-executor';
import { MailActionPlanService } from './mail-action-plan.service';
import { FakeMailActionPrisma } from './test-support/fake-mail-action-prisma';

describe('MailActionApprovalService (ТЗ разд. 7/8/14)', () => {
  let prisma: FakeMailActionPrisma;
  let plans: MailActionPlanService;
  let approvals: MailActionApprovalService;

  beforeEach(() => {
    prisma = new FakeMailActionPrisma();
    plans = new MailActionPlanService(prisma as never);
    const execution = new MailActionExecutionService(prisma as never, new MailActionExecutorRegistry(), {} as never);
    // start() реально исполняет пункты — в тестах согласия это намеренно
    // не интересует (проверяется отдельно в mail-action-execution.service.spec.ts),
    // поэтому глушим здесь, чтобы не тянуть исполнители.
    jest.spyOn(execution, 'start').mockResolvedValue(undefined);
    approvals = new MailActionApprovalService(prisma as never, execution);
  });

  async function planWithOneItem() {
    const plan = await plans.createPlan('owner', 'mbx-1', { requestText: 'x' });
    await plans.attachAnalysisResult(plan.id, [
      { localId: 'a', type: 'ARCHIVE', stableObjectIds: ['msg-1'], sourceLocators: {}, reason: 'r', parameters: { folder: 'Archive' } },
    ]);
    const { items } = await plans.listItemsWithConflicts('owner', plan.id);
    return { plan, item: items[0] };
  }

  it('согласует группу: пункт переходит в APPROVED, создаётся исполнение', async () => {
    const { plan, item } = await planWithOneItem();
    const result = await approvals.approveGroup('owner', plan.id, { planVersion: plan.version, groupType: 'MAILBOX_ORDER', itemIds: [item.id] });
    expect(prisma.items[0].status).toBe('APPROVED');
    expect(prisma.items[0].approvalId).toBe(result.approval.id);
    expect(prisma.executions).toHaveLength(1);
    expect(prisma.executions[0].approvalId).toBe(result.approval.id);
  });

  it('несовпадение planVersion — 409', async () => {
    const { plan, item } = await planWithOneItem();
    await expect(
      approvals.approveGroup('owner', plan.id, { planVersion: plan.version + 1, groupType: 'MAILBOX_ORDER', itemIds: [item.id] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('чужой план — 404', async () => {
    const { plan, item } = await planWithOneItem();
    await expect(
      approvals.approveGroup('intruder', plan.id, { planVersion: plan.version, groupType: 'MAILBOX_ORDER', itemIds: [item.id] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('пункт не из указанной группы — конфликт', async () => {
    const { plan, item } = await planWithOneItem();
    await expect(
      approvals.approveGroup('owner', plan.id, { planVersion: plan.version, groupType: 'WORK_OBJECTS', itemIds: [item.id] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('снятый с выбора пункт — нельзя согласовать', async () => {
    const { plan, item } = await planWithOneItem();
    await plans.patchItem('owner', plan.id, item.id, { version: item.version, selected: false });
    await expect(
      approvals.approveGroup('owner', plan.id, { planVersion: plan.version, groupType: 'MAILBOX_ORDER', itemIds: [item.id] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('конфликтующие пункты в одном согласии — отказ', async () => {
    const plan = await plans.createPlan('owner', 'mbx-1', { requestText: 'x' });
    await plans.attachAnalysisResult(plan.id, [
      { localId: 'a', type: 'ARCHIVE', stableObjectIds: ['msg-1'], sourceLocators: {}, reason: 'r', parameters: {} },
      { localId: 'b', type: 'TRASH', stableObjectIds: ['msg-1'], sourceLocators: {}, reason: 'r', parameters: {} },
    ]);
    const { items } = await plans.listItemsWithConflicts('owner', plan.id);
    await expect(
      approvals.approveGroup('owner', plan.id, {
        planVersion: plan.version,
        groupType: 'MAILBOX_ORDER',
        itemIds: items.map((i) => i.id),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('MOVE зависит от CREATE_FOLDER, не входящего в согласие и ещё не исполненного — отказ UNSATISFIED_DEPENDENCY', async () => {
    const plan = await plans.createPlan('owner', 'mbx-1', { requestText: 'x' });
    await plans.attachAnalysisResult(plan.id, [
      { localId: 'folder', type: 'CREATE_FOLDER', stableObjectIds: [], sourceLocators: {}, reason: 'r', parameters: { name: 'Новая' } },
      {
        localId: 'move',
        type: 'MOVE',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'r',
        parameters: { folder: 'Новая' },
        dependsOnLocalIds: ['folder'],
      },
    ]);
    const { items } = await plans.listItemsWithConflicts('owner', plan.id);
    const move = items.find((i) => i.type === 'MOVE')!;
    await expect(
      approvals.approveGroup('owner', plan.id, { planVersion: plan.version, groupType: 'MAILBOX_ORDER', itemIds: [move.id] }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('MOVE и его CREATE_FOLDER согласуются вместе — проходит', async () => {
    const plan = await plans.createPlan('owner', 'mbx-1', { requestText: 'x' });
    await plans.attachAnalysisResult(plan.id, [
      { localId: 'folder', type: 'CREATE_FOLDER', stableObjectIds: [], sourceLocators: {}, reason: 'r', parameters: { name: 'Новая' } },
      {
        localId: 'move',
        type: 'MOVE',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'r',
        parameters: { folder: 'Новая' },
        dependsOnLocalIds: ['folder'],
      },
    ]);
    const { items } = await plans.listItemsWithConflicts('owner', plan.id);
    await expect(
      approvals.approveGroup('owner', plan.id, { planVersion: plan.version, groupType: 'MAILBOX_ORDER', itemIds: items.map((i) => i.id) }),
    ).resolves.toBeDefined();
  });
});

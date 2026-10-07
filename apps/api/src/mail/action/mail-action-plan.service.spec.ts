import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MailActionPlanService } from './mail-action-plan.service';
import { FakeMailActionPrisma } from './test-support/fake-mail-action-prisma';
import { computeMailActionPayloadHash } from './mail-action-rules';

describe('MailActionPlanService (ТЗ разд. 4/6/14)', () => {
  let prisma: FakeMailActionPrisma;
  let service: MailActionPlanService;

  beforeEach(() => {
    prisma = new FakeMailActionPrisma();
    service = new MailActionPlanService(prisma as never);
  });

  it('создаёт план в статусе ANALYZING', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', {
      requestText: 'разложи рассылки',
    });
    expect(plan.status).toBe('ANALYZING');
    expect(plan.ownerId).toBe('owner');
  });

  it('attachAnalysisResult создаёт пункты и переводит план в READY', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', {
      requestText: 'архивируй старое',
    });
    await service.attachAnalysisResult(plan.id, [
      {
        localId: 'c1',
        type: 'ARCHIVE',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'старое письмо',
        parameters: { folder: 'Archive' },
      },
    ]);
    const { items } = await service.listItemsWithConflicts('owner', plan.id);
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('NEEDS_REVIEW');
    expect(items[0].groupType).toBe('MAILBOX_ORDER');
    const reread = await service.getPlanOrThrow('owner', plan.id);
    expect(reread.status).toBe('READY');
  });

  it('dependsOnLocalIds разворачивается в настоящие id пунктов', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', {
      requestText: 'x',
    });
    await service.attachAnalysisResult(plan.id, [
      {
        localId: 'folder',
        type: 'CREATE_FOLDER',
        stableObjectIds: [],
        sourceLocators: {},
        reason: 'r',
        parameters: { name: 'Новая' },
      },
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
    const { items } = await service.listItemsWithConflicts('owner', plan.id);
    const move = items.find((i) => i.type === 'MOVE')!;
    const folder = items.find((i) => i.type === 'CREATE_FOLDER')!;
    expect(move.dependsOnItemIds).toEqual([folder.id]);
  });

  it('listItemsWithConflicts чужого плана — 404', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', {
      requestText: 'x',
    });
    await expect(
      service.getPlanOrThrow('someone-else', plan.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listItemsWithConflicts находит конфликт между выбранными пунктами', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', {
      requestText: 'x',
    });
    await service.attachAnalysisResult(plan.id, [
      {
        localId: 'a',
        type: 'ARCHIVE',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'r',
        parameters: {},
      },
      {
        localId: 'b',
        type: 'TRASH',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'r',
        parameters: {},
      },
    ]);
    const { conflicts } = await service.listItemsWithConflicts(
      'owner',
      plan.id,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].code).toBe('TERMINAL_MOVE');
  });

  it('снятый с выбора пункт не участвует в конфликтах', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', {
      requestText: 'x',
    });
    await service.attachAnalysisResult(plan.id, [
      {
        localId: 'a',
        type: 'ARCHIVE',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'r',
        parameters: {},
      },
      {
        localId: 'b',
        type: 'TRASH',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'r',
        parameters: {},
      },
    ]);
    const { items } = await service.listItemsWithConflicts('owner', plan.id);
    const b = items.find((i) => i.type === 'TRASH')!;
    await service.patchItem('owner', plan.id, b.id, {
      version: b.version,
      selected: false,
    });
    const { conflicts } = await service.listItemsWithConflicts(
      'owner',
      plan.id,
    );
    expect(conflicts).toHaveLength(0);
  });

  it('patchItem с неверной версией — 409', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', {
      requestText: 'x',
    });
    await service.attachAnalysisResult(plan.id, [
      {
        localId: 'a',
        type: 'ARCHIVE',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'r',
        parameters: {},
      },
    ]);
    const { items } = await service.listItemsWithConflicts('owner', plan.id);
    await expect(
      service.patchItem('owner', plan.id, items[0].id, {
        version: 999,
        selected: false,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('правка параметров пересчитывает payloadHash и снимает согласие', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', {
      requestText: 'x',
    });
    await service.attachAnalysisResult(plan.id, [
      {
        localId: 'a',
        type: 'MOVE',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'r',
        parameters: { folder: 'A' },
      },
    ]);
    const { items } = await service.listItemsWithConflicts('owner', plan.id);
    const item = items[0];
    // Имитируем, что пункт уже был согласован (как сделал бы approveGroup).
    prisma.items[0].approvalId = 'appr-1';
    prisma.items[0].status = 'APPROVED';

    const patched = await service.patchItem('owner', plan.id, item.id, {
      version: item.version,
      parameters: { folder: 'B' },
    });
    expect(patched.payloadHash).toBe(
      computeMailActionPayloadHash('MOVE', { folder: 'B' }),
    );
    expect(patched.approvalId).toBeNull();
    expect(patched.status).toBe('NEEDS_REVIEW');
  });

  it('patchItem на пункте в RUNNING — запрещено', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', {
      requestText: 'x',
    });
    await service.attachAnalysisResult(plan.id, [
      {
        localId: 'a',
        type: 'ARCHIVE',
        stableObjectIds: ['msg-1'],
        sourceLocators: {},
        reason: 'r',
        parameters: {},
      },
    ]);
    prisma.items[0].status = 'RUNNING';
    await expect(
      service.patchItem('owner', plan.id, prisma.items[0].id, {
        version: 1,
        selected: false,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('patchItem на FAILED пункте — разрешено, правка параметров снимает согласие и возвращает в NEEDS_REVIEW (раздел 17 ТЗ: исправить ARCHIVE_FOLDER_MISSING)', async () => {
    const plan = await service.createPlan('owner', 'mbx-1', { requestText: 'x' });
    await service.attachAnalysisResult(plan.id, [
      { localId: 'a', type: 'ARCHIVE', stableObjectIds: ['msg-1'], sourceLocators: {}, reason: 'r', parameters: {} },
    ]);
    prisma.items[0].status = 'FAILED';
    prisma.items[0].approvalId = 'appr-1';

    const patched = await service.patchItem('owner', plan.id, prisma.items[0].id, {
      version: prisma.items[0].version,
      parameters: { folderPath: 'INBOX/Archive' },
    });
    expect(patched.status).toBe('NEEDS_REVIEW');
    expect(patched.approvalId).toBeNull();
    expect(patched.parameters).toEqual({ folderPath: 'INBOX/Archive' });
  });
});

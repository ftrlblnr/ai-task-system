import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { MailActionItem } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ApproveMailActionGroupDto } from './dto/approve-mail-action-group.dto';
import { MailActionExecutionService } from './mail-action-execution.service';
import {
  computeMailActionPayloadHash,
  computeSnapshotHash,
  validateMailActionConflicts,
} from './mail-action-rules';

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000; // раздел 14 ТЗ — 24ч по умолчанию

// Раздел 7/14 ТЗ — согласие ОДНОЙ группы плана. Создаёт неизменяемый снимок
// согласованных пунктов и сразу запускает исполнение (fire-and-forget, тот
// же приём, что ReceptionNotificationsCron/MailDigestCron — HTTP-ответ не
// ждёт завершения работы движка).
@Injectable()
export class MailActionApprovalService {
  private readonly logger = new Logger(MailActionApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly execution: MailActionExecutionService,
  ) {}

  async approveGroup(
    ownerId: string,
    planId: string,
    dto: ApproveMailActionGroupDto,
  ) {
    const plan = await this.prisma.mailActionPlan.findUnique({
      where: { id: planId },
    });
    if (!plan || plan.ownerId !== ownerId)
      throw new NotFoundException('План не найден');
    if (plan.version !== dto.planVersion) {
      throw new ConflictException(
        'PLAN_VERSION_CONFLICT: план изменился с момента открытия, перечитайте его',
      );
    }

    const items = await this.prisma.mailActionItem.findMany({
      where: { id: { in: dto.itemIds }, planId: plan.id },
    });
    if (items.length !== dto.itemIds.length)
      throw new NotFoundException(
        'Один или несколько пунктов плана не найдены',
      );

    for (const item of items) {
      if (item.groupType !== dto.groupType) {
        throw new ConflictException(
          `ITEM_WRONG_GROUP: пункт ${item.id} не принадлежит группе ${dto.groupType}`,
        );
      }
      if (!item.selected)
        throw new ConflictException(
          `ITEM_NOT_SELECTED: пункт ${item.id} снят с выбора`,
        );
      if (item.status !== 'NEEDS_REVIEW')
        throw new ConflictException(
          `ITEM_WRONG_STATUS: пункт ${item.id} не в статусе NEEDS_REVIEW`,
        );
      if (
        item.payloadHash !==
        computeMailActionPayloadHash(item.type, item.parameters)
      ) {
        // Защитная проверка, не должна срабатывать в норме: payloadHash
        // пересчитывается при каждой правке параметров (patchItem).
        throw new ConflictException(
          `ITEM_PAYLOAD_CHANGED: пункт ${item.id} изменился, перечитайте план`,
        );
      }
    }

    const conflicts = validateMailActionConflicts(
      items.map((i) => ({
        localId: i.id,
        type: i.type,
        stableObjectIds: i.stableObjectIds,
        dependsOnItemIds: i.dependsOnItemIds,
      })),
    );
    if (conflicts.length > 0) {
      throw new ConflictException({
        message: 'ITEM_CONFLICTS: в выбранных пунктах есть конфликты',
        conflicts,
      });
    }

    // Раздел 8 ТЗ — зависимость (CREATE_FOLDER → MOVE) должна быть либо в
    // этом же согласии, либо уже успешно исполнена ранее — иначе исполнение
    // не сможет её удовлетворить вообще никогда.
    const itemIdSet = new Set(items.map((i) => i.id));
    const unsatisfiedDepIds = [
      ...new Set(
        items
          .flatMap((i) => i.dependsOnItemIds)
          .filter((depId) => !itemIdSet.has(depId)),
      ),
    ];
    if (unsatisfiedDepIds.length > 0) {
      const deps = await this.prisma.mailActionItem.findMany({
        where: { id: { in: unsatisfiedDepIds } },
      });
      const unsatisfied = deps.filter((d) => d.status !== 'SUCCEEDED');
      if (unsatisfied.length > 0) {
        throw new ConflictException({
          message:
            'UNSATISFIED_DEPENDENCY: зависимость пункта не согласована и не исполнена',
          itemIds: unsatisfied.map((d) => d.id),
        });
      }
    }

    const snapshot = items.map((i: MailActionItem) => ({
      id: i.id,
      type: i.type,
      parameters: i.parameters,
      stableObjectIds: i.stableObjectIds,
      sourceLocators: i.sourceLocators,
      payloadHash: i.payloadHash,
    }));

    const approval = await this.prisma.$transaction(async (tx) => {
      const created = await tx.mailActionApproval.create({
        data: {
          actorId: ownerId,
          planId: plan.id,
          planVersion: plan.version,
          groupType: dto.groupType,
          itemIds: dto.itemIds,
          immutableActionSnapshot: snapshot,
          payloadHash: computeSnapshotHash(snapshot),
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        },
      });
      await tx.mailActionItem.updateMany({
        where: { id: { in: dto.itemIds } },
        data: {
          approvalId: created.id,
          status: 'APPROVED',
          version: { increment: 1 },
        },
      });
      await tx.mailActionExecution.create({ data: { approvalId: created.id } });
      return created;
    });

    const execution = await this.prisma.mailActionExecution.findUniqueOrThrow({
      where: { approvalId: approval.id },
    });
    void this.execution
      .start(execution.id)
      .catch((err: unknown) =>
        this.logger.error(
          `execution start failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );

    return { approval, executionId: execution.id };
  }
}

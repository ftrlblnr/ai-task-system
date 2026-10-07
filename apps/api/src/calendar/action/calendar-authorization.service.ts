import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CalendarAction } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CalendarActionExecutionService } from './calendar-action-execution.service';
import { computeCalendarActionPayloadHash, computeCalendarSnapshotHash } from './calendar-action-rules';

const AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000; // раздел 17 ТЗ — 24ч по умолчанию

export interface ApproveActionsInput {
  planVersion: number;
  actionIds: string[];
}

// Раздел 17 ТЗ — EXPLICIT_APPROVAL согласие на набор действий плана.
// Запускает исполнение fire-and-forget сразу после создания (тот же
// приём, что mail/action/mail-action-approval.service.ts и
// ReceptionNotificationsCron — HTTP-ответ не ждёт завершения работы
// движка).
@Injectable()
export class CalendarAuthorizationService {
  private readonly logger = new Logger(CalendarAuthorizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly execution: CalendarActionExecutionService,
  ) {}

  async approve(ownerId: string, planId: string, dto: ApproveActionsInput) {
    const plan = await this.prisma.calendarPlan.findUnique({ where: { id: planId } });
    if (!plan || plan.ownerId !== ownerId) throw new NotFoundException('План не найден');
    if (plan.version !== dto.planVersion) {
      throw new ConflictException('CALENDAR_PLAN_VERSION_CONFLICT: план изменился с момента открытия, перечитайте его');
    }
    if (plan.status !== 'NEEDS_APPROVAL') {
      throw new ConflictException(`CALENDAR_PLAN_WRONG_STATUS: план в статусе ${plan.status}, не NEEDS_APPROVAL`);
    }

    const actions = await this.prisma.calendarAction.findMany({ where: { id: { in: dto.actionIds }, planId: plan.id } });
    if (actions.length !== dto.actionIds.length) throw new NotFoundException('Одно или несколько действий плана не найдены');

    for (const action of actions) {
      if (action.status !== 'PENDING') {
        throw new ConflictException(`CALENDAR_ACTION_WRONG_STATUS: действие ${action.id} не в статусе PENDING`);
      }
      if (action.payloadHash !== computeCalendarActionPayloadHash(action.type, action.parameters)) {
        throw new ConflictException(`CALENDAR_ACTION_PAYLOAD_CHANGED: действие ${action.id} изменилось, перечитайте план`);
      }
    }

    // Раздел 8/17 ТЗ — зависимость (например создать событие → потом
    // пригласить гостей) должна быть либо в этом же согласии, либо уже
    // успешно исполнена ранее.
    const actionIdSet = new Set(actions.map((a) => a.id));
    const unsatisfiedDepIds = [...new Set(actions.flatMap((a) => a.dependsOnActionIds).filter((depId) => !actionIdSet.has(depId)))];
    if (unsatisfiedDepIds.length > 0) {
      const deps = await this.prisma.calendarAction.findMany({ where: { id: { in: unsatisfiedDepIds } } });
      const unsatisfied = deps.filter((d) => d.status !== 'SUCCEEDED');
      if (unsatisfied.length > 0) {
        throw new ConflictException({
          message: 'CALENDAR_UNSATISFIED_DEPENDENCY: зависимость действия не согласована и не исполнена',
          actionIds: unsatisfied.map((d) => d.id),
        });
      }
    }

    const snapshot = actions.map((a: CalendarAction) => ({
      id: a.id,
      type: a.type,
      targetEventId: a.targetEventId,
      beforeVersion: a.beforeVersion,
      parameters: a.parameters,
      payloadHash: a.payloadHash,
    }));

    const authorization = await this.prisma.$transaction(async (tx) => {
      const created = await tx.calendarAuthorization.create({
        data: {
          actorId: ownerId,
          planId: plan.id,
          planVersion: plan.version,
          basis: 'EXPLICIT_APPROVAL',
          actionIds: dto.actionIds,
          immutableActionSnapshot: snapshot,
          payloadHash: computeCalendarSnapshotHash(snapshot),
          expiresAt: new Date(Date.now() + AUTHORIZATION_TTL_MS),
        },
      });
      await tx.calendarAction.updateMany({ where: { id: { in: dto.actionIds } }, data: { authorizationId: created.id, version: { increment: 1 } } });
      await tx.calendarPlan.update({ where: { id: plan.id }, data: { status: 'APPROVED', version: { increment: 1 } } });
      await tx.calendarActionExecution.create({ data: { authorizationId: created.id } });
      return created;
    });

    const execution = await this.prisma.calendarActionExecution.findUniqueOrThrow({ where: { authorizationId: authorization.id } });
    void this.execution.start(execution.id).catch((err: unknown) => this.logger.error(`execution start failed: ${err instanceof Error ? err.message : String(err)}`));

    return { authorization, executionId: execution.id };
  }
}

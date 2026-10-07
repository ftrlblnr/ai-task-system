import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CalendarAction, CalendarActionStatus, CalendarActionType, CalendarAttemptOutcome, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { computeCalendarActionPayloadHash } from './calendar-action-rules';

// Раздел 20 ТЗ — одно предложенное действие. localId — метка ТОЛЬКО для
// связывания dependsOn внутри одного вызова createPlan, в план не попадает.
export interface CalendarActionCandidate {
  localId: string;
  type: CalendarActionType;
  targetEventId?: string | null;
  beforeVersion?: number | null;
  parameters: Prisma.InputJsonValue;
  dependsOnLocalIds?: string[];
}

// Раздел 16 ТЗ — редактировать параметры можно, пока действие не
// исполняется, ЛИБО если попытка не привела к успеху (тот же принцип, что
// mail/action/mail-action-plan.service.ts EDITABLE_ITEM_STATUSES).
const EDITABLE_ACTION_STATUSES: ReadonlySet<CalendarActionStatus> = new Set(['PENDING', 'FAILED', 'UNKNOWN', 'SKIPPED_CHANGED', 'BLOCKED_DEPENDENCY']);

export interface CalendarActionView extends CalendarAction {
  lastAttempt: { errorCode: string | null; outcome: CalendarAttemptOutcome | null; finishedAt: Date | null } | null;
}

export interface PatchCalendarActionInput {
  version: number;
  parameters?: Record<string, unknown>;
}

// Календарный агент, раздел 7/20 ТЗ — план и его действия. Сам разбор
// поручения на структурированные действия (ассистент/voice tool) — вне
// этого сервиса: он только хранит/версионирует/исполняет уже готовый
// список, как mail/action/mail-action-plan.service.ts хранит уже готовый
// результат анализа почты.
@Injectable()
export class CalendarPlanService {
  constructor(private readonly prisma: PrismaService) {}

  // Раздел 7 ТЗ — "одиночные встречи": как правило один CalendarAction на
  // план, иногда несколько зависимых (например создать событие → потом
  // пригласить гостей отдельным действием) — candidates может быть пустым,
  // тогда план остаётся DRAFT до того, как действия появятся.
  async createPlan(ownerId: string, requestText: string, candidates: CalendarActionCandidate[] = []) {
    const idByLocalId = new Map(candidates.map((c) => [c.localId, randomUUID()]));
    const planId = randomUUID();

    await this.prisma.$transaction([
      this.prisma.calendarPlan.create({
        data: { id: planId, ownerId, requestText, status: candidates.length > 0 ? 'NEEDS_APPROVAL' : 'DRAFT' },
      }),
      ...candidates.map((c) =>
        this.prisma.calendarAction.create({
          data: {
            id: idByLocalId.get(c.localId)!,
            planId,
            type: c.type,
            targetEventId: c.targetEventId ?? null,
            beforeVersion: c.beforeVersion ?? null,
            parameters: c.parameters,
            payloadHash: computeCalendarActionPayloadHash(c.type, c.parameters),
            dependsOnActionIds: (c.dependsOnLocalIds ?? []).map((localId) => idByLocalId.get(localId) ?? localId),
          },
        }),
      ),
    ]);

    return this.getPlanOrThrow(ownerId, planId);
  }

  async listPlans(ownerId: string) {
    return this.prisma.calendarPlan.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  async getPlanOrThrow(ownerId: string, planId: string) {
    const plan = await this.prisma.calendarPlan.findUnique({ where: { id: planId } });
    if (!plan || plan.ownerId !== ownerId) throw new NotFoundException('План не найден');
    return plan;
  }

  async listActions(ownerId: string, planId: string): Promise<CalendarActionView[]> {
    const plan = await this.getPlanOrThrow(ownerId, planId);
    const rows = await this.prisma.calendarAction.findMany({
      where: { planId: plan.id },
      orderBy: { createdAt: 'asc' },
      include: { attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 } },
    });
    return rows.map(({ attempts, ...action }) => ({
      ...action,
      lastAttempt: attempts[0] ? { errorCode: attempts[0].errorCode, outcome: attempts[0].outcome, finishedAt: attempts[0].finishedAt } : null,
    }));
  }

  // Раздел 14 ТЗ — правка параметров снимает согласие (authorizationId),
  // новое согласие нужно получить заново. Тот же принцип, что у почтового
  // агента (patchItem), не распространяется на другие действия плана.
  async patchAction(ownerId: string, planId: string, actionId: string, dto: PatchCalendarActionInput): Promise<CalendarAction> {
    const plan = await this.getPlanOrThrow(ownerId, planId);
    const action = await this.prisma.calendarAction.findUnique({ where: { id: actionId } });
    if (!action || action.planId !== plan.id) throw new NotFoundException('Действие плана не найдено');
    if (action.version !== dto.version) {
      throw new ConflictException('CALENDAR_ACTION_VERSION_CONFLICT: действие изменилось, перечитайте план');
    }
    if (!EDITABLE_ACTION_STATUSES.has(action.status)) {
      throw new ForbiddenException('CALENDAR_ACTION_NOT_EDITABLE: действие уже исполняется или завершено');
    }

    const parametersChanged = dto.parameters !== undefined;
    const nextParameters = (parametersChanged ? dto.parameters! : action.parameters) as Prisma.InputJsonValue;
    const nextPayloadHash = parametersChanged ? computeCalendarActionPayloadHash(action.type, nextParameters) : action.payloadHash;
    const wasAuthorized = action.authorizationId !== null;

    return this.prisma.calendarAction.update({
      where: { id: action.id },
      data: {
        parameters: nextParameters,
        payloadHash: nextPayloadHash,
        version: { increment: 1 },
        ...(parametersChanged && wasAuthorized ? { authorizationId: null, status: 'PENDING' } : {}),
      },
    });
  }
}

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MailActionAttemptOutcome,
  MailActionExecutionState,
  MailActionGroupType,
  MailActionItem,
  MailActionItemStatus,
  MailActionRelevance,
  MailActionType,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMailActionPlanDto } from './dto/create-mail-action-plan.dto';
import { PatchMailActionItemDto } from './dto/patch-mail-action-item.dto';
import {
  computeMailActionPayloadHash,
  GROUP_BY_ACTION_TYPE,
  MailActionConflict,
  validateMailActionConflicts,
} from './mail-action-rules';

// Один предложенный пункт — выход этапа анализа (#123, LLM по уже
// синкнутым письмам). localId — произвольная метка анализатора ТОЛЬКО для
// связывания dependsOn внутри одного вызова attachAnalysisResult, в план не
// попадает (там уже настоящие id строк).
export interface MailActionCandidate {
  localId: string;
  type: MailActionType;
  stableObjectIds: string[];
  sourceLocators: Prisma.InputJsonValue;
  reason: string;
  evidence?: Prisma.InputJsonValue;
  relevance?: MailActionRelevance;
  parameters: Prisma.InputJsonValue;
  dependsOnLocalIds?: string[];
}

// Раздел 16 ТЗ — редактировать параметры/выбор можно, пока пункт ещё не
// исполняется, ЛИБО если попытка исполнения не привела к успеху (FAILED/
// UNKNOWN/SKIPPED_CHANGED/BLOCKED_DEPENDENCY — владелец должен суметь
// исправить параметры, например указать другую папку для ARCHIVE, когда
// \Archive не нашлась, раздел 9/17 ТЗ). QUEUED/RUNNING/SUCCEEDED/CANCELLED/
// COMPENSATED — нет, это уже либо в процессе, либо завершено окончательно.
const EDITABLE_ITEM_STATUSES: ReadonlySet<MailActionItemStatus> = new Set([
  'DRAFT',
  'NEEDS_REVIEW',
  'APPROVED',
  'FAILED',
  'UNKNOWN',
  'SKIPPED_CHANGED',
  'BLOCKED_DEPENDENCY',
]);

export interface MailActionItemView extends MailActionItem {
  lastAttempt: { errorCode: string | null; outcome: MailActionAttemptOutcome | null; finishedAt: Date | null } | null;
}

export interface PlanItemsView {
  items: MailActionItemView[];
  conflicts: MailActionConflict[];
}

// Экран согласования (web /mail, вкладка «Планы действий») — пункт хранит только
// stableObjectIds, а владельцу нужно видеть, О КАКОМ письме речь; и после
// перезагрузки страницы — найти исполнения своих согласий (executionId
// иначе живёт только в ответе approve).
export interface PlanContextView {
  messages: Record<string, { subject: string | null; fromName: string | null; fromAddress: string; receivedAt: Date | null }>;
  executions: {
    id: string;
    state: MailActionExecutionState;
    groupType: MailActionGroupType;
    itemIds: string[];
    approvedAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    cancelRequestedAt: Date | null;
  }[];
}

// Почтовый ИИ-агент v2.0 — план/пункты (раздел 4/6/14 ТЗ). Сам анализ
// намерения (какие именно действия предложить по requestText) — отдельная
// подсистема Этапа 1 (#123, LLM по уже синкнутым письмам), сюда попадает
// через attachAnalysisResult() уже готовым списком пунктов. Этот сервис
// отвечает только за хранение/версионирование/конфликты плана — он не знает
// про IMAP и про конкретные типы действий.
@Injectable()
export class MailActionPlanService {
  constructor(private readonly prisma: PrismaService) {}

  async createPlan(
    ownerId: string,
    mailboxId: string,
    dto: CreateMailActionPlanDto,
  ) {
    return this.prisma.mailActionPlan.create({
      data: {
        ownerId,
        mailboxId,
        requestText: dto.requestText,
        scope: {
          folderPaths: dto.folderPaths ?? null,
          since: dto.since ?? null,
          until: dto.until ?? null,
        } satisfies Prisma.InputJsonValue,
        snapshotAt: new Date(),
      },
    });
  }

  // Этап 3 почты (23.10.2026) — план от ассистента в чате: пункты уже
  // выбраны моделью по конкретным письмам, анализ не нужен — план сразу
  // READY и ждёт «Подтвердить» в карточке. sourceKey — ключ вызова
  // инструмента: повтор того же ответа возвращает уже созданный план.
  async createReadyPlan(ownerId: string, mailboxId: string, requestText: string, candidates: MailActionCandidate[], sourceKey: string) {
    let plan = await this.prisma.mailActionPlan.findUnique({ where: { sourceKey } });
    if (plan && (plan.ownerId !== ownerId || plan.mailboxId !== mailboxId)) throw new ConflictException('SOURCE_KEY_MISMATCH: ключ плана занят');
    if (!plan) {
      try {
        plan = await this.prisma.mailActionPlan.create({
          data: { ownerId, mailboxId, requestText: requestText.slice(0, 2000), sourceKey, scope: { folderPaths: null, since: null, until: null, source: 'assistant' }, snapshotAt: new Date() },
        });
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        plan = await this.prisma.mailActionPlan.findUniqueOrThrow({ where: { sourceKey } });
      }
    }
    // Сбой между созданием плана и пунктов оставил бы его ANALYZING навсегда — повтор доводит до READY.
    if (plan.status === 'ANALYZING') {
      await this.attachAnalysisResult(plan.id, candidates, { source: 'assistant', proposedCount: candidates.length });
      plan = await this.prisma.mailActionPlan.findUniqueOrThrow({ where: { id: plan.id } });
    }
    return plan;
  }

  // Раздел 6 ТЗ — анализатор (#123) зовёт это ОДИН раз на план, когда
  // закончил разбор requestText против содержимого ящика: создаёт пункты
  // статусом NEEDS_REVIEW (уже можно согласовывать) и переводит план
  // ANALYZING → READY. Собственной валидацией конфликтов здесь не
  // занимается — listItemsWithConflicts() считает их на лету при чтении,
  // чтобы правка одного пункта не требовала пересчёта и записи всех.
  async attachAnalysisResult(
    planId: string,
    candidates: MailActionCandidate[],
    coverage?: Prisma.InputJsonValue,
  ): Promise<void> {
    const idByLocalId = new Map(
      candidates.map((c) => [c.localId, randomUUID()]),
    );

    await this.prisma.$transaction([
      ...candidates.map((c) =>
        this.prisma.mailActionItem.create({
          data: {
            id: idByLocalId.get(c.localId)!,
            planId,
            type: c.type,
            groupType: GROUP_BY_ACTION_TYPE[c.type],
            stableObjectIds: c.stableObjectIds,
            sourceLocators: c.sourceLocators,
            reason: c.reason,
            evidence: c.evidence,
            relevance: c.relevance,
            parameters: c.parameters,
            payloadHash: computeMailActionPayloadHash(c.type, c.parameters),
            dependsOnItemIds: (c.dependsOnLocalIds ?? []).map(
              (localId) => idByLocalId.get(localId) ?? localId,
            ),
            status: 'NEEDS_REVIEW',
          },
        }),
      ),
      this.prisma.mailActionPlan.update({
        where: { id: planId },
        data: { status: 'READY', coverage },
      }),
    ]);
  }

  // Раздел 6 ТЗ — coverage хранит "ошибки" наравне с "обнаружено/проверено":
  // сбой анализа (LLM недоступен и т.п.) не оставляет план в ANALYZING
  // навечно — READY с нулём пунктов и причиной в coverage, владелец видит
  // честный результат, а не бесконечную загрузку.
  async markAnalysisFailed(planId: string, reason: string): Promise<void> {
    await this.prisma.mailActionPlan.update({
      where: { id: planId },
      data: { status: 'READY', coverage: { error: reason } },
    });
  }

  async listPlans(ownerId: string, mailboxId: string) {
    return this.prisma.mailActionPlan.findMany({
      where: { ownerId, mailboxId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getPlanOrThrow(ownerId: string, planId: string) {
    const plan = await this.prisma.mailActionPlan.findUnique({
      where: { id: planId },
    });
    if (!plan) throw new NotFoundException('План не найден');
    if (plan.ownerId !== ownerId) throw new NotFoundException('План не найден');
    return plan;
  }

  async listItemsWithConflicts(
    ownerId: string,
    planId: string,
  ): Promise<PlanItemsView> {
    const plan = await this.getPlanOrThrow(ownerId, planId);
    const rows = await this.prisma.mailActionItem.findMany({
      where: { planId: plan.id },
      orderBy: { createdAt: 'asc' },
      include: { attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 } },
    });
    // Раздел 17 ТЗ — почему пункт не исполнился должно быть видно без
    // отдельного запроса к журналу попыток (например ARCHIVE_FOLDER_MISSING,
    // чтобы владелец понял, что нужно выбрать/создать папку).
    const items = rows.map(({ attempts, ...item }) => ({
      ...item,
      lastAttempt: attempts[0] ? { errorCode: attempts[0].errorCode, outcome: attempts[0].outcome, finishedAt: attempts[0].finishedAt } : null,
    }));
    const selected = items.filter((i) => i.selected);
    const conflicts = validateMailActionConflicts(
      selected.map((i) => ({
        localId: i.id,
        type: i.type,
        stableObjectIds: i.stableObjectIds,
        dependsOnItemIds: i.dependsOnItemIds,
      })),
    );
    return { items, conflicts };
  }

  async getPlanContext(ownerId: string, planId: string): Promise<PlanContextView> {
    const plan = await this.getPlanOrThrow(ownerId, planId);
    const [items, approvals] = await Promise.all([
      this.prisma.mailActionItem.findMany({ where: { planId: plan.id }, select: { stableObjectIds: true } }),
      this.prisma.mailActionApproval.findMany({
        where: { planId: plan.id },
        orderBy: { approvedAt: 'desc' },
        include: { execution: true },
      }),
    ]);
    const messageIds = [...new Set(items.flatMap((i) => i.stableObjectIds))];
    const messages = messageIds.length
      ? await this.prisma.emailMessage.findMany({
          where: { id: { in: messageIds }, mailboxId: plan.mailboxId },
          select: { id: true, subject: true, fromName: true, fromAddress: true, receivedAt: true },
        })
      : [];
    return {
      messages: Object.fromEntries(messages.map(({ id, ...m }) => [id, m])),
      executions: approvals.flatMap((a) =>
        a.execution
          ? [
              {
                id: a.execution.id,
                state: a.execution.state,
                groupType: a.groupType,
                itemIds: a.itemIds,
                approvedAt: a.approvedAt,
                startedAt: a.execution.startedAt,
                finishedAt: a.execution.finishedAt,
                cancelRequestedAt: a.execution.cancelRequestedAt,
              },
            ]
          : [],
      ),
    };
  }

  // Раздел 14 ТЗ — правка параметров/выбора пункта. Если пункт уже был
  // согласован (approvalId стоит), правка СНИМАЕТ согласие с этого пункта
  // (новое согласие нужно получить заново) — не трогает чужие пункты той же
  // группы/approval, они остаются согласованы как были.
  async patchItem(
    ownerId: string,
    planId: string,
    itemId: string,
    dto: PatchMailActionItemDto,
  ): Promise<MailActionItem> {
    const plan = await this.getPlanOrThrow(ownerId, planId);
    const item = await this.prisma.mailActionItem.findUnique({
      where: { id: itemId },
    });
    if (!item || item.planId !== plan.id)
      throw new NotFoundException('Пункт плана не найден');
    if (item.version !== dto.version) {
      throw new ConflictException(
        'ITEM_VERSION_CONFLICT: пункт плана изменился, перечитайте план',
      );
    }
    if (!EDITABLE_ITEM_STATUSES.has(item.status)) {
      throw new ForbiddenException(
        'ITEM_NOT_EDITABLE: пункт уже исполняется или завершён',
      );
    }

    const parametersChanged = dto.parameters !== undefined;
    const nextParameters = (
      parametersChanged ? dto.parameters! : item.parameters
    ) as Prisma.InputJsonValue;
    const nextPayloadHash = parametersChanged
      ? computeMailActionPayloadHash(item.type, nextParameters)
      : item.payloadHash;
    const wasApproved = item.approvalId !== null;

    return this.prisma.mailActionItem.update({
      where: { id: item.id },
      data: {
        selected: dto.selected ?? item.selected,
        parameters: nextParameters,
        payloadHash: nextPayloadHash,
        version: { increment: 1 },
        ...(parametersChanged && wasApproved
          ? { approvalId: null, status: 'NEEDS_REVIEW' }
          : {}),
      },
    });
  }
}

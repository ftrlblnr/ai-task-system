import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MailActionItem, MailActionItemStatus, MailActionRelevance, MailActionType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMailActionPlanDto } from './dto/create-mail-action-plan.dto';
import { PatchMailActionItemDto } from './dto/patch-mail-action-item.dto';
import { computeMailActionPayloadHash, GROUP_BY_ACTION_TYPE, MailActionConflict, validateMailActionConflicts } from './mail-action-rules';

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
// исполняется/не исполнен. После QUEUED движок уже мог начать читать строку.
const EDITABLE_ITEM_STATUSES: ReadonlySet<MailActionItemStatus> = new Set(['DRAFT', 'NEEDS_REVIEW', 'APPROVED']);

export interface PlanItemsView {
  items: MailActionItem[];
  conflicts: MailActionConflict[];
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

  async createPlan(ownerId: string, mailboxId: string, dto: CreateMailActionPlanDto) {
    return this.prisma.mailActionPlan.create({
      data: {
        ownerId,
        mailboxId,
        requestText: dto.requestText,
        scope: { folderPaths: dto.folderPaths ?? null, since: dto.since ?? null, until: dto.until ?? null } satisfies Prisma.InputJsonValue,
        snapshotAt: new Date(),
      },
    });
  }

  // Раздел 6 ТЗ — анализатор (#123) зовёт это ОДИН раз на план, когда
  // закончил разбор requestText против содержимого ящика: создаёт пункты
  // статусом NEEDS_REVIEW (уже можно согласовывать) и переводит план
  // ANALYZING → READY. Собственной валидацией конфликтов здесь не
  // занимается — listItemsWithConflicts() считает их на лету при чтении,
  // чтобы правка одного пункта не требовала пересчёта и записи всех.
  async attachAnalysisResult(planId: string, candidates: MailActionCandidate[]): Promise<void> {
    const idByLocalId = new Map(candidates.map((c) => [c.localId, randomUUID()]));

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
            dependsOnItemIds: (c.dependsOnLocalIds ?? []).map((localId) => idByLocalId.get(localId) ?? localId),
            status: 'NEEDS_REVIEW',
          },
        }),
      ),
      this.prisma.mailActionPlan.update({ where: { id: planId }, data: { status: 'READY' } }),
    ]);
  }

  async listPlans(ownerId: string, mailboxId: string) {
    return this.prisma.mailActionPlan.findMany({
      where: { ownerId, mailboxId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getPlanOrThrow(ownerId: string, planId: string) {
    const plan = await this.prisma.mailActionPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('План не найден');
    if (plan.ownerId !== ownerId) throw new NotFoundException('План не найден');
    return plan;
  }

  async listItemsWithConflicts(ownerId: string, planId: string): Promise<PlanItemsView> {
    const plan = await this.getPlanOrThrow(ownerId, planId);
    const items = await this.prisma.mailActionItem.findMany({ where: { planId: plan.id }, orderBy: { createdAt: 'asc' } });
    const selected = items.filter((i) => i.selected);
    const conflicts = validateMailActionConflicts(
      selected.map((i) => ({ localId: i.id, type: i.type, stableObjectIds: i.stableObjectIds, dependsOnItemIds: i.dependsOnItemIds })),
    );
    return { items, conflicts };
  }

  // Раздел 14 ТЗ — правка параметров/выбора пункта. Если пункт уже был
  // согласован (approvalId стоит), правка СНИМАЕТ согласие с этого пункта
  // (новое согласие нужно получить заново) — не трогает чужие пункты той же
  // группы/approval, они остаются согласованы как были.
  async patchItem(ownerId: string, planId: string, itemId: string, dto: PatchMailActionItemDto): Promise<MailActionItem> {
    const plan = await this.getPlanOrThrow(ownerId, planId);
    const item = await this.prisma.mailActionItem.findUnique({ where: { id: itemId } });
    if (!item || item.planId !== plan.id) throw new NotFoundException('Пункт плана не найден');
    if (item.version !== dto.version) {
      throw new ConflictException('ITEM_VERSION_CONFLICT: пункт плана изменился, перечитайте план');
    }
    if (!EDITABLE_ITEM_STATUSES.has(item.status)) {
      throw new ForbiddenException('ITEM_NOT_EDITABLE: пункт уже исполняется или завершён');
    }

    const parametersChanged = dto.parameters !== undefined;
    const nextParameters = (parametersChanged ? dto.parameters! : item.parameters) as Prisma.InputJsonValue;
    const nextPayloadHash = parametersChanged ? computeMailActionPayloadHash(item.type, nextParameters) : item.payloadHash;
    const wasApproved = item.approvalId !== null;

    return this.prisma.mailActionItem.update({
      where: { id: item.id },
      data: {
        selected: dto.selected ?? item.selected,
        parameters: nextParameters,
        payloadHash: nextPayloadHash,
        version: { increment: 1 },
        ...(parametersChanged && wasApproved ? { approvalId: null, status: 'NEEDS_REVIEW' as MailActionItemStatus } : {}),
      },
    });
  }
}

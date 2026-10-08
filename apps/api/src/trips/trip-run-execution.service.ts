import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TripExtractionService } from './trip-extraction.service';
import { composeTripFromMaterials, parseDateOrNull, type ComposedTrip, type MaterialDraft } from './trip-compose';

// Раздел 8/18 ТЗ — durable job обработки одного пакета материалов. Claim-
// паттерн (SELECT...FOR UPDATE SKIP LOCKED) — тот же приём, что
// reception/reception-notifications.cron.ts и mail/calendar action
// execution-сервисы: не изобретается заново.
const BATCH_SIZE = 3;
// LLM-вызовы на каждый материал внутри одного run — потолок выше, чем у
// reception (там одно HTTP-уведомление), запас на несколько материалов по
// очереди в одном прогоне.
const LOCK_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// Раздел 3 ТЗ — "эвристика, не LLM-вызов": перекрытие периода ±3 дня
// считается "похоже на ту же поездку". Сознательно НЕ авто-объединяет —
// только сигнализирует, окончательное решение (это новая поездка или
// продолжение старой) оставляется человеку.
const DUPLICATE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

interface ClaimedRun {
  id: string;
  initiatorId: string;
}

@Injectable()
export class TripRunExecutionService {
  private readonly logger = new Logger(TripRunExecutionService.name);
  private readonly workerId = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    private readonly extraction: TripExtractionService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processPending(): Promise<void> {
    const claimed = await this.claimBatch();
    for (const run of claimed) {
      await this.process(run);
    }
  }

  private async claimBatch(): Promise<ClaimedRun[]> {
    const now = new Date();
    const lockThreshold = new Date(now.getTime() - LOCK_TTL_MS);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "AgentRun"
          WHERE "status" IN ('RECEIVED', 'EXTRACTING', 'MATCHING', 'COMPOSING')
            AND "attempts" < ${MAX_ATTEMPTS}
            AND ("lockedAt" IS NULL OR "lockedAt" < ${lockThreshold})
          ORDER BY "createdAt" ASC
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED`,
      );
      if (locked.length === 0) return [];
      const ids = locked.map((r) => r.id);
      await tx.agentRun.updateMany({
        where: { id: { in: ids } },
        data: { lockedAt: now, lockedBy: this.workerId, attempts: { increment: 1 }, status: 'RECEIVED' },
      });
      return tx.agentRun.findMany({ where: { id: { in: ids } }, select: { id: true, initiatorId: true } });
    });
  }

  // Основная обработка одного пакета — EXTRACTING → MATCHING → COMPOSING →
  // READY/READY_WITH_ISSUES. Каждая попытка (claim) идёт заново с начала:
  // draft'ы извлечения не кэшируются между попытками (сознательное
  // упрощение v1 — повтор после сбоя стоит повторных LLM-вызовов, но
  // остаётся корректным; MAX_ATTEMPTS=3 ограничивает стоимость такого сбоя).
  async process(run: ClaimedRun): Promise<void> {
    try {
      await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: 'EXTRACTING', startedAt: new Date() } });
      const materials = await this.prisma.tripMaterial.findMany({ where: { agentRunId: run.id } });

      const materialDrafts: MaterialDraft[] = [];
      let anyUnreadable = false;
      for (const material of materials) {
        const outcome = await this.extraction.extractOne(material.fileArtifactId);
        if (outcome.status === 'EXTRACTED') {
          await this.prisma.tripMaterial.update({ where: { id: material.id }, data: { processingStatus: 'EXTRACTED', extractionIssue: null } });
          materialDrafts.push({ materialId: material.id, fileLabel: outcome.fileName, draft: outcome.draft });
        } else {
          anyUnreadable = true;
          await this.prisma.tripMaterial.update({ where: { id: material.id }, data: { processingStatus: outcome.status, extractionIssue: outcome.issue } });
        }
      }

      await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: 'MATCHING' } });
      const composed = composeTripFromMaterials(materialDrafts);
      const matchIssue = await this.findPossibleExistingTripIssue(run.initiatorId, composed);

      await this.prisma.agentRun.update({ where: { id: run.id }, data: { status: 'COMPOSING' } });
      const trip = await this.createTripFromComposed(run.initiatorId, composed, materials.map((m) => m.id));

      const issues = matchIssue ? [...composed.issues, matchIssue] : composed.issues;
      const finalStatus = anyUnreadable || issues.length > 0 ? 'READY_WITH_ISSUES' : 'READY';
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: finalStatus, tripId: trip.id, finishedAt: new Date(), lockedAt: null, errorSummary: issues.length > 0 ? issues.join(' | ') : null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`trip run ${run.id} failed: ${message}`);
      const fresh = await this.prisma.agentRun.findUnique({ where: { id: run.id } });
      const permanent = !fresh || fresh.attempts >= MAX_ATTEMPTS;
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: permanent ? { status: 'FAILED', errorSummary: message, lockedAt: null, finishedAt: new Date() } : { status: 'RECEIVED', errorSummary: message, lockedAt: null },
      });
    }
  }

  // Раздел 3 ТЗ — только эвристика на СВОИХ (organizerId) незавершённых
  // поездках: сверять со всеми поездками в системе означало бы заглянуть в
  // чужие (раздел 9 про изоляцию между поездками), этого здесь нет.
  private async findPossibleExistingTripIssue(organizerId: string, composed: ComposedTrip): Promise<string | null> {
    if (!composed.periodStart && !composed.destinationHint) return null;
    const candidates = await this.prisma.trip.findMany({ where: { organizerId, cancelledAt: null } });
    for (const candidate of candidates) {
      const overlaps = Boolean(composed.periodStart && candidate.periodStart && Math.abs(candidate.periodStart.getTime() - composed.periodStart.getTime()) <= DUPLICATE_WINDOW_MS);
      const sameDestination = Boolean(composed.destinationHint && candidate.title.toLowerCase().includes(composed.destinationHint.toLowerCase()));
      if (overlaps || sameDestination) {
        return `Похоже на уже существующую поездку «${candidate.title}» (${candidate.humanCode}) — проверьте перед тем, как считать это новой поездкой`;
      }
    }
    return null;
  }

  private async createTripFromComposed(organizerId: string, composed: ComposedTrip, materialIds: string[]) {
    const year = new Date().getFullYear();
    const title = composed.summaryHint ?? (composed.destinationHint ? `Поездка: ${composed.destinationHint}` : `Поездка ${year}`);

    for (let attempt = 0; attempt < 5; attempt++) {
      const existingCount = await this.prisma.trip.count({ where: { humanCode: { startsWith: `TR-${year}-` } } });
      const humanCode = `TR-${year}-${String(existingCount + 1 + attempt).padStart(3, '0')}`;
      try {
        return await this.prisma.$transaction(async (tx) => {
          const trip = await tx.trip.create({
            data: {
              humanCode,
              title,
              purposeSummary: composed.summaryHint,
              organizerId,
              periodStart: composed.periodStart,
              periodEnd: composed.periodEnd,
              periodPrecision: composed.periodPrecision,
            },
          });
          await tx.tripMember.create({ data: { tripId: trip.id, employeeId: organizerId, accessRole: 'ORGANIZER' } });

          for (const leg of composed.legs) {
            await tx.tripLeg.create({
              data: {
                tripId: trip.id,
                mode: leg.mode,
                fromLocation: leg.fromLocation,
                toLocation: leg.toLocation,
                departAt: parseDateOrNull(leg.departAt),
                departTimeZoneOffsetMinutes: leg.departTimeZoneOffsetMinutes,
                arriveAt: parseDateOrNull(leg.arriveAt),
                arriveTimeZoneOffsetMinutes: leg.arriveTimeZoneOffsetMinutes,
                carrier: leg.carrier,
                referenceCode: leg.referenceCode,
                bookingStatus: leg.bookingStatus,
                sourceMaterialId: leg.sourceMaterialId,
              },
            });
          }
          for (const event of composed.events) {
            await tx.tripEvent.create({
              data: {
                tripId: trip.id,
                title: event.title,
                startAt: parseDateOrNull(event.startAt),
                startTimeZoneOffsetMinutes: event.startTimeZoneOffsetMinutes,
                dateOnly: parseDateOrNull(event.dateOnly),
                endAt: parseDateOrNull(event.endAt),
                location: event.location,
                notes: event.notes,
                sourceMaterialId: event.sourceMaterialId,
              },
            });
          }
          for (const stay of composed.stays) {
            await tx.tripStay.create({
              data: {
                tripId: trip.id,
                name: stay.name,
                address: stay.address,
                checkInAt: parseDateOrNull(stay.checkInAt),
                checkOutAt: parseDateOrNull(stay.checkOutAt),
                bookingStatus: stay.bookingStatus,
                sourceMaterialId: stay.sourceMaterialId,
              },
            });
          }
          for (const contact of composed.contacts) {
            await tx.tripContact.create({
              data: {
                tripId: trip.id,
                name: contact.name,
                role: contact.role,
                organization: contact.organization,
                email: contact.email,
                phone: contact.phone,
                sourceMaterialId: contact.sourceMaterialId,
              },
            });
          }
          for (const fact of composed.facts) {
            await tx.extractedFact.create({
              data: { tripId: trip.id, materialId: fact.sourceMaterialId, factKey: fact.key, factValue: fact.value, status: 'EXTRACTED' },
            });
          }

          await tx.tripMaterial.updateMany({ where: { id: { in: materialIds } }, data: { tripId: trip.id } });
          return trip;
        });
      } catch (err) {
        if (isUniqueConstraintError(err) && attempt < 4) continue;
        throw err;
      }
    }
    throw new Error('Не удалось выделить код поездки после нескольких попыток');
  }
}

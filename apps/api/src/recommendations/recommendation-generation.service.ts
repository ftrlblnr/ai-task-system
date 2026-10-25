import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import Anthropic from '@anthropic-ai/sdk';
import {
  MessagePartType,
  MessageRole,
  MemoryStatus,
  Prisma,
  RecommendationBatch,
  RecommendationBatchStatus,
  RecommendationBatchTrigger,
  Role,
  SkillRevisionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiUsageService, errorText } from '../ai-usage/ai-usage.service';
import { callCostUsd } from '../ai-usage/ai-usage-prices';
import { TONE_SLUG } from '../skills/skill-catalog';
import {
  buildRecoUserContent,
  parseRecommendations,
  recoTargetKey,
  RECO_MAX_TOKENS,
  RECO_MODEL,
  RECO_SCHEMA,
  RECO_SYSTEM,
  RECO_WINDOW_MS,
  weekKeyFor,
  type RecoInput,
  type RecoTargets,
} from './recommendation-prompt';

// Фоновая генерация рекомендаций (ARMS, фаза 5): строка RecommendationBatch
// + @Cron + claim SKIP LOCKED, как у предложений по навыкам. Opus 5.5 с
// размышлениями пишет минуту-две — в HTTP-запросе это не держим.

const LOCK_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 2;
const MAX_CHAT_MESSAGES = 300;
const FEATURE = 'recos.weekly';

@Injectable()
export class RecommendationGenerationService {
  private readonly logger = new Logger(RecommendationGenerationService.name);
  private client: Anthropic | null = null;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    return this.client;
  }

  // Пятница 09:00 по Алматы (UTC+5): по прогону на каждого руководителя.
  @Cron('0 0 4 * * 5')
  async scheduleWeekly(now = new Date()): Promise<number> {
    const owners = await this.prisma.employee.findMany({ where: { role: { in: [Role.OWNER, Role.ADMIN] }, status: 'ACTIVE' }, select: { id: true } });
    const weekKey = weekKeyFor(now);
    const created = await this.prisma.recommendationBatch.createMany({
      data: owners.map((o) => ({ ownerId: o.id, trigger: RecommendationBatchTrigger.SCHEDULE, weekKey })),
      skipDuplicates: true,
    });
    return created.count;
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processPending(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const batch = await this.claimOne();
      if (batch) await this.process(batch);
    } finally {
      this.busy = false;
    }
  }

  async claimOne(): Promise<RecommendationBatch | null> {
    const now = new Date();
    const threshold = new Date(now.getTime() - LOCK_TTL_MS);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "RecommendationBatch"
          WHERE "status" = 'GENERATING' AND "attempts" < ${MAX_ATTEMPTS}
            AND ("lockedAt" IS NULL OR "lockedAt" < ${threshold})
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (locked.length === 0) {
        await tx.recommendationBatch.updateMany({
          where: { status: RecommendationBatchStatus.GENERATING, attempts: { gte: MAX_ATTEMPTS }, lockedAt: { lt: threshold } },
          data: { status: RecommendationBatchStatus.FAILED, error: 'Не удалось собрать рекомендации', lockedAt: null, finishedAt: now },
        });
        return null;
      }
      return tx.recommendationBatch.update({ where: { id: locked[0].id }, data: { lockedAt: now, attempts: { increment: 1 } } });
    });
  }

  async process(batch: RecommendationBatch): Promise<void> {
    try {
      const { input, targets } = await this.collect(batch.ownerId, new Date());
      const known = await this.knownKeys(batch.ownerId, new Date());
      const { text, usage } = await this.generate(buildRecoUserContent(input), batch);
      const items = parseRecommendations(text, targets, known);
      const costUsd = callCostUsd({
        model: RECO_MODEL,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      });
      await this.prisma.$transaction([
        this.prisma.recommendation.createMany({
          data: items.map((r) => ({
            ownerId: batch.ownerId,
            batchId: batch.id,
            area: r.area,
            action: r.action,
            title: r.title,
            benefit: r.benefit,
            plan: r.plan,
            effort: r.effort,
            priority: r.priority,
            tokenSaving: r.tokenSaving,
            payload: r.payload as unknown as Prisma.InputJsonValue,
            fingerprint: r.fingerprint,
          })),
        }),
        this.prisma.recommendationBatch.update({
          where: { id: batch.id },
          data: {
            status: RecommendationBatchStatus.DONE,
            tokensIn: usage.input_tokens,
            tokensOut: usage.output_tokens,
            costUsd,
            lockedAt: null,
            error: null,
            finishedAt: new Date(),
          },
        }),
      ]);
      this.logger.log(`recommendations batch ${batch.id} owner=${batch.ownerId}: ${items.length}`);
    } catch (err) {
      const final = batch.attempts >= MAX_ATTEMPTS;
      this.logger.error(`recommendations batch ${batch.id} failed (attempt ${batch.attempts}): ${errorText(err)}`);
      await this.prisma.recommendationBatch.update({
        where: { id: batch.id },
        data: final
          ? { status: RecommendationBatchStatus.FAILED, error: 'Не удалось собрать рекомендации', lockedAt: null, finishedAt: new Date() }
          : { lockedAt: null },
      });
    }
  }

  // Все бывшие рекомендации — по отпечатку; цель — пока открыта, отклонена
  // или применена за 30 дней (потом цель снова можно предлагать).
  async knownKeys(ownerId: string, now: Date): Promise<Set<string>> {
    const since30 = new Date(now.getTime() - 30 * 86400_000);
    const rows = await this.prisma.recommendation.findMany({ where: { ownerId }, select: { fingerprint: true, action: true, payload: true, status: true, decidedAt: true } });
    const keys = new Set<string>();
    for (const r of rows) {
      keys.add(r.fingerprint);
      const recent = r.status !== 'APPLIED' || (r.decidedAt !== null && r.decidedAt > since30);
      const targetKey = recoTargetKey(r.action, (r.payload as { targetId?: string | null } | null)?.targetId ?? null);
      if (recent && targetKey) keys.add(targetKey);
    }
    return keys;
  }

  // Данные недели одного руководителя + допустимые цели для проверки ответа.
  async collect(ownerId: string, now: Date): Promise<{ input: RecoInput; targets: RecoTargets }> {
    const since = new Date(now.getTime() - RECO_WINDOW_MS);
    const since30 = new Date(now.getTime() - 30 * 86400_000);
    const [messages, calls, skills, runs7, runs30, feedback, routines, routineRuns, memory, revisions, recos] = await Promise.all([
      this.prisma.message.findMany({
        where: { role: MessageRole.USER, createdAt: { gt: since, lte: now }, conversation: { employeeId: ownerId } },
        orderBy: { createdAt: 'asc' },
        take: MAX_CHAT_MESSAGES,
        select: { createdAt: true, parts: { where: { type: MessagePartType.MARKDOWN }, orderBy: { order: 'asc' }, select: { data: true } } },
      }),
      this.prisma.aiCall.findMany({
        where: { createdAt: { gt: since, lte: now } },
        select: { feature: true, model: true, ok: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, cacheWrite1hTokens: true },
      }),
      this.prisma.skill.findMany({ where: { OR: [{ ownerId: null }, { ownerId }] }, orderBy: { createdAt: 'asc' } }),
      this.prisma.skillRun.groupBy({ by: ['skillId'], where: { ownerId, createdAt: { gt: since } }, _count: { _all: true } }),
      this.prisma.skillRun.groupBy({ by: ['skillId'], where: { ownerId, createdAt: { gt: since30 } }, _count: { _all: true } }),
      this.prisma.skillRun.findMany({
        where: { ownerId, feedback: { not: null }, feedbackAt: { gt: since30 } },
        orderBy: { feedbackAt: 'desc' },
        select: { skillId: true, feedback: true, feedbackText: true },
      }),
      this.prisma.routine.findMany({ where: { ownerId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.routineRun.findMany({
        where: { routine: { ownerId }, createdAt: { gt: since } },
        select: { routineId: true, status: true, tokensIn: true, tokensOut: true, costUsd: true },
      }),
      this.prisma.memoryItem.findMany({ where: { ownerId, status: MemoryStatus.ACTIVE }, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.prisma.skillRevision.findMany({
        where: { status: SkillRevisionStatus.REJECTED, decidedAt: { gt: since30 }, skill: { OR: [{ ownerId: null }, { ownerId }] } },
        select: { reason: true, skill: { select: { slug: true } } },
        take: 20,
      }),
      this.prisma.recommendation.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 200, select: { title: true, status: true, decidedAt: true } }),
    ]);

    const ai = new Map<string, RecoInput['ai'][number]>();
    for (const c of calls) {
      const a = ai.get(c.feature) ?? { feature: c.feature, calls: 0, errors: 0, costUsd: 0, tokens: 0 };
      a.calls += 1;
      if (!c.ok) a.errors += 1;
      a.costUsd += callCostUsd(c) ?? 0;
      a.tokens += (c.inputTokens ?? 0) + (c.outputTokens ?? 0) + (c.cacheReadTokens ?? 0) + (c.cacheWriteTokens ?? 0);
      ai.set(c.feature, a);
    }
    const count7 = new Map(runs7.map((r) => [r.skillId, r._count._all]));
    const count30 = new Map(runs30.map((r) => [r.skillId, r._count._all]));
    const routineStats = new Map<string, { runs: Record<string, number>; tokens: number; cost: number }>();
    for (const r of routineRuns) {
      const s = routineStats.get(r.routineId) ?? { runs: {}, tokens: 0, cost: 0 };
      s.runs[r.status] = (s.runs[r.status] ?? 0) + 1;
      s.tokens += r.tokensIn + r.tokensOut;
      s.cost += r.costUsd ?? 0;
      routineStats.set(r.routineId, s);
    }

    const input: RecoInput = {
      now,
      chat: messages
        .map((m) => ({
          at: m.createdAt,
          text: m.parts
            .map((p) => (p.data as { content?: unknown })?.content)
            .filter((c): c is string => typeof c === 'string')
            .join(' '),
        }))
        .filter((m) => m.text.trim().length >= 3),
      ai: [...ai.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 40),
      skills: skills.map((s) => {
        const fb = feedback.filter((f) => f.skillId === s.id);
        return {
          id: s.id,
          slug: s.slug,
          title: s.title,
          model: s.model,
          enabled: s.enabled,
          shared: s.ownerId === null,
          service: s.slug === TONE_SLUG,
          runs7d: count7.get(s.id) ?? 0,
          runs30d: count30.get(s.id) ?? 0,
          up: fb.filter((f) => f.feedback === 'UP').length,
          down: fb.filter((f) => f.feedback === 'DOWN').length,
          comments: fb
            .filter((f) => f.feedback === 'DOWN' && f.feedbackText)
            .slice(0, 3)
            .map((f) => (f.feedbackText as string).slice(0, 200)),
        };
      }),
      routines: routines.map((r) => {
        const s = routineStats.get(r.id);
        return {
          id: r.id,
          title: r.title,
          state: r.state,
          schedule: r.schedule,
          mode: r.mode,
          weeklyTokenCap: r.weeklyTokenCap,
          runs: s?.runs ?? {},
          tokens7d: s?.tokens ?? 0,
          costUsd7d: s?.cost ?? 0,
        };
      }),
      memory: memory.map((m) => ({ id: m.id, kind: m.kind, text: m.text, useCount: m.useCount, lastUsedAt: m.lastUsedAt })),
      rejectedRevisions: revisions.map((r) => `/${r.skill.slug}: ${r.reason ?? 'без причины'}`),
      dismissed: recos.filter((r) => r.status === 'DISMISSED').map((r) => r.title),
      open: recos.filter((r) => r.status === 'NEW' || r.status === 'IN_CART').map((r) => r.title),
      applied: recos.filter((r) => r.status === 'APPLIED' && r.decidedAt && r.decidedAt > since30).map((r) => r.title),
    };
    const targets: RecoTargets = {
      skills: new Map(skills.map((s) => [s.id, { model: s.model, enabled: s.enabled, service: s.slug === TONE_SLUG }])),
      routines: new Set(routines.map((r) => r.id)),
      memory: new Set(memory.map((m) => m.id)),
    };
    return { input, targets };
  }

  private async generate(content: string, batch: RecommendationBatch): Promise<{ text: string; usage: Anthropic.Usage }> {
    const started = Date.now();
    const meta = { batchId: batch.id, ownerId: batch.ownerId };
    let message: Anthropic.Message;
    try {
      message = await this.getClient()
        .messages.stream({
          model: RECO_MODEL,
          max_tokens: RECO_MAX_TOKENS,
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: RECO_SCHEMA as unknown as Record<string, unknown> } },
          system: RECO_SYSTEM,
          messages: [{ role: 'user', content }],
        })
        .finalMessage();
    } catch (err) {
      this.aiUsage?.record({ feature: FEATURE, model: RECO_MODEL, latencyMs: Date.now() - started, ok: false, error: errorText(err), meta });
      throw err;
    }
    this.aiUsage?.record({ feature: FEATURE, model: RECO_MODEL, latencyMs: Date.now() - started, ok: true, usage: message.usage, meta });
    if (message.stop_reason === 'refusal') throw new Error('Модель отказалась отвечать');
    if (message.stop_reason === 'max_tokens') throw new Error('Ответ модели обрезан');
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, usage: message.usage };
  }
}

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import Anthropic from '@anthropic-ai/sdk';
import { MessagePartType, Prisma, SkillRevision, SkillRevisionSource, SkillRevisionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiUsageService, errorText } from '../ai-usage/ai-usage.service';
import {
  buildFeedbackUserContent,
  buildToneUserContent,
  countToneEmails,
  FEEDBACK_SYSTEM,
  parseRevision,
  REVISION_SCHEMA,
  TONE_SYSTEM,
  type FeedbackSample,
} from './skill-revision-prompt';

// Фоновая генерация предложений по навыкам (тот же приём, что разборы
// договоров: строка в БД + @Cron + claim SKIP LOCKED). Opus 5.5 с
// размышлениями пишет минуту-две — в HTTP-запросе это не держим.
// Принудительный tool_choice на Opus 5.5 даёт 400, поэтому ответ — через
// output_config.format (JSON по схеме).

const MODEL = 'claude-opus-5-5';
const LOCK_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 2;
const FEEDBACK_SAMPLES = 30;
const TONE_EMAILS = 40;
const MIN_TONE_EMAILS = 3;

export class RevisionInputError extends Error {}

@Injectable()
export class SkillRevisionService {
  private readonly logger = new Logger(SkillRevisionService.name);
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

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processPending(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const revision = await this.claimOne();
      if (revision) await this.process(revision);
    } finally {
      this.busy = false;
    }
  }

  async claimOne(): Promise<SkillRevision | null> {
    const now = new Date();
    const threshold = new Date(now.getTime() - LOCK_TTL_MS);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "SkillRevision"
          WHERE "status" = 'GENERATING' AND "attempts" < ${MAX_ATTEMPTS}
            AND ("lockedAt" IS NULL OR "lockedAt" < ${threshold})
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (locked.length === 0) {
        // Брошенные (процесс упал) без попыток — FAILED, иначе висели бы вечно.
        await tx.skillRevision.updateMany({
          where: { status: SkillRevisionStatus.GENERATING, attempts: { gte: MAX_ATTEMPTS }, lockedAt: { lt: threshold } },
          data: { status: SkillRevisionStatus.FAILED, error: 'Не удалось подготовить предложение', lockedAt: null },
        });
        return null;
      }
      return tx.skillRevision.update({ where: { id: locked[0].id }, data: { lockedAt: now, attempts: { increment: 1 } } });
    });
  }

  async process(revision: SkillRevision): Promise<void> {
    try {
      const skill = await this.prisma.skill.findUniqueOrThrow({ where: { id: revision.skillId } });
      const { system, content } =
        revision.source === SkillRevisionSource.SENT_MAIL
          ? { system: TONE_SYSTEM, content: await this.toneContent(revision.createdById) }
          : { system: FEEDBACK_SYSTEM, content: buildFeedbackUserContent(skill, await this.feedbackSamples(skill.id)) };
      const result = await this.generate(system, content, `skill.train:${skill.slug}`, skill.id);
      await this.prisma.skillRevision.update({
        where: { id: revision.id },
        data: { status: SkillRevisionStatus.PROPOSED, instructions: result.instructions, reason: result.reason, lockedAt: null, error: null },
      });
      this.logger.log(`skill revision ${revision.id} (${skill.slug}, ${revision.source}) готово`);
    } catch (err) {
      const permanent = err instanceof RevisionInputError;
      const final = permanent || revision.attempts >= MAX_ATTEMPTS;
      this.logger.error(`skill revision ${revision.id} failed (attempt ${revision.attempts}): ${errorText(err)}`);
      await this.prisma.skillRevision.update({
        where: { id: revision.id },
        data: final
          ? { status: SkillRevisionStatus.FAILED, error: permanent ? (err as Error).message : 'Не удалось подготовить предложение', lockedAt: null }
          : { lockedAt: null },
      });
    }
  }

  private async feedbackSamples(skillId: string): Promise<FeedbackSample[]> {
    const runs = await this.prisma.skillRun.findMany({
      where: { skillId, feedback: { not: null } },
      orderBy: { feedbackAt: 'desc' },
      take: FEEDBACK_SAMPLES,
      select: { feedback: true, feedbackText: true, inputText: true, outputMessageId: true },
    });
    const messageIds = runs.map((r) => r.outputMessageId).filter((id): id is string => !!id);
    const parts = await this.prisma.messagePart.findMany({
      where: { messageId: { in: messageIds }, type: MessagePartType.MARKDOWN },
      orderBy: { order: 'asc' },
      select: { messageId: true, data: true },
    });
    const answers = new Map<string, string>();
    for (const p of parts) {
      const content = (p.data as { content?: unknown })?.content;
      if (typeof content === 'string') answers.set(p.messageId, `${answers.get(p.messageId) ?? ''}${content}\n`);
    }
    return runs.map((r) => ({
      value: r.feedback as 'UP' | 'DOWN',
      text: r.feedbackText,
      input: r.inputText,
      answer: (r.outputMessageId && answers.get(r.outputMessageId)?.trim()) || '(ответ не сохранился)',
    }));
  }

  // Отправленные письма того, кто нажал «Собрать из писем» (руководитель).
  private async toneContent(employeeId: string | null): Promise<string> {
    if (!employeeId) throw new RevisionInputError('Не указан руководитель');
    const emails = await this.prisma.emailMessage.findMany({
      where: { isOutgoing: true, deletedAt: null, isAutomated: false, mailbox: { employeeId }, textBody: { not: null } },
      orderBy: { sentAt: 'desc' },
      take: TONE_EMAILS,
      select: { subject: true, textBody: true },
    });
    const list = emails.map((e) => ({ subject: e.subject, body: e.textBody ?? '' }));
    if (countToneEmails(list) < MIN_TONE_EMAILS) throw new RevisionInputError('Мало отправленных писем — нужно хотя бы три');
    return buildToneUserContent(list);
  }

  private async generate(system: string, content: string, feature: string, skillId: string): Promise<{ instructions: string; reason: string }> {
    const started = Date.now();
    let message: Anthropic.Message;
    try {
      message = await this.getClient()
        .messages.stream({
          model: MODEL,
          max_tokens: 16000,
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: REVISION_SCHEMA as unknown as Record<string, unknown> } },
          system,
          messages: [{ role: 'user', content }],
        })
        .finalMessage();
    } catch (err) {
      this.aiUsage?.record({ feature, model: MODEL, latencyMs: Date.now() - started, ok: false, error: errorText(err), meta: { skillId } });
      throw err;
    }
    this.aiUsage?.record({ feature, model: MODEL, latencyMs: Date.now() - started, ok: true, usage: message.usage, meta: { skillId } });
    if (message.stop_reason === 'refusal') throw new RevisionInputError('Модель отказалась отвечать на этот запрос');
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseRevision(text);
  }
}

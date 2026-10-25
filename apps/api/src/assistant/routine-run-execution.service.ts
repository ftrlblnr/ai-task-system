import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import Anthropic from '@anthropic-ai/sdk';
import { MessagePartType, MessageRole, Prisma, RoutineChannel, RoutineMode, RoutineRun, RoutineRunStatus, RoutineState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { isManager } from '../auth/roles';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AiUsageService, errorText, trackedCreate } from '../ai-usage/ai-usage.service';
import { callCostUsd } from '../ai-usage/ai-usage-prices';
import { MemoryService } from '../memory/memory.service';
import { SkillsService } from '../skills/skills.service';
import { SKILL_EFFORT_VALUES, SKILL_MAX_TOKENS, SKILL_MODEL_IDS } from '../skills/skill-catalog';
import {
  buildRoutineBlock,
  capNoticeDue,
  capReached,
  noticesToMarkdown,
  NOTIFY_TOOL_NAME,
  parseNotify,
  ROUTINE_MAX_TOOL_ROUNDS,
  ROUTINE_PROMPT_EFFORT,
  ROUTINE_PROMPT_MAX_TOKENS,
  ROUTINE_PROMPT_MODEL,
  ROUTINE_SYSTEM,
  routineTools,
  runSummary,
  usageTokens,
  WEEK_MS,
  type RoutineNotice,
} from '../routines/routine-catalog';
import { AssistantToolsService, isWriteTool, toolResultForModel } from './assistant-tools.service';
import { buildDateContext } from './assistant-reply.service';
import { clipForTelegram, markdownToTelegramText } from './skill-run-execution.service';

// ARMS, фаза 4 — прогон регламента. Тот же durable-приём, что ▶ навыка
// (строка RoutineRun + @Cron + claim SKIP LOCKED), но свой цикл модели, а не
// чат: регламент работает без человека — только читающие инструменты,
// пассивный режим с notify_owner, свой учёт токенов под недельный лимит, и
// «ничего важного» не должно оставлять следов в ленте.

const LOCK_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 2;

export interface RoutineCall {
  model: string;
  effort: 'low' | 'medium' | 'high';
  maxTokens: number;
  instructions: string;
  allowedTools: string[] | null;
}

export interface RoutineOutcome {
  text: string;
  notices: RoutineNotice[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

function feedTitle(title: string, at: Date): string {
  const when = at.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `${title} · ${when}`;
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

@Injectable()
export class RoutineRunExecutionService {
  private readonly logger = new Logger(RoutineRunExecutionService.name);
  private client: Anthropic | null = null;
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly tools: AssistantToolsService,
    @Optional() private readonly aiUsage?: AiUsageService,
    @Optional() private readonly memory?: MemoryService,
    @Optional() private readonly skills?: SkillsService,
    @Optional() private readonly telegram?: TelegramBotService,
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
      const run = await this.claimOne();
      if (run) await this.process(run);
    } finally {
      this.busy = false;
    }
  }

  async claimOne(): Promise<RoutineRun | null> {
    const now = new Date();
    const threshold = new Date(now.getTime() - LOCK_TTL_MS);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "RoutineRun"
          WHERE "attempts" < ${MAX_ATTEMPTS}
            AND ("status" = 'QUEUED' OR ("status" = 'RUNNING' AND "lockedAt" < ${threshold}))
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (locked.length === 0) {
        await tx.routineRun.updateMany({
          where: { status: RoutineRunStatus.RUNNING, attempts: { gte: MAX_ATTEMPTS }, lockedAt: { lt: threshold } },
          data: { status: RoutineRunStatus.FAILED, error: 'Не удалось выполнить регламент', lockedAt: null, finishedAt: now },
        });
        return null;
      }
      return tx.routineRun.update({
        where: { id: locked[0].id },
        data: { status: RoutineRunStatus.RUNNING, lockedAt: now, attempts: { increment: 1 }, startedAt: now, error: null },
      });
    });
  }

  async process(run: RoutineRun): Promise<void> {
    try {
      const routine = await this.prisma.routine.findUnique({
        where: { id: run.routineId },
        include: { skill: true, owner: { select: { id: true, email: true, role: true, status: true, telegramId: true } } },
      });
      // Права — на момент исполнения, не постановки в очередь.
      if (!routine || routine.owner.status !== 'ACTIVE' || !isManager(routine.owner.role)) {
        await this.finish(run.id, RoutineRunStatus.FAILED, { error: 'Регламент недоступен' });
        return;
      }
      if (routine.state === RoutineState.DRAFT) {
        await this.finish(run.id, RoutineRunStatus.FAILED, { error: 'Регламент не включён' });
        return;
      }
      if (!routine.prompt && (!routine.skill || !routine.skill.enabled)) {
        await this.finish(run.id, RoutineRunStatus.FAILED, { error: 'Навык регламента удалён или в архиве' });
        return;
      }

      const now = new Date();
      if (routine.weeklyTokenCap) {
        const used = await this.prisma.routineRun.aggregate({
          where: { routineId: routine.id, createdAt: { gte: new Date(now.getTime() - WEEK_MS) }, id: { not: run.id } },
          _sum: { tokensIn: true, tokensOut: true },
        });
        if (capReached((used._sum.tokensIn ?? 0) + (used._sum.tokensOut ?? 0), routine.weeklyTokenCap)) {
          await this.finish(run.id, RoutineRunStatus.SKIPPED_CAP, { error: 'Недельный лимит токенов исчерпан' });
          // Одно уведомление в неделю, а не на каждый пропущенный слот.
          if (capNoticeDue(routine.capNotifiedAt, now)) {
            await this.prisma.routine.update({ where: { id: routine.id }, data: { capNotifiedAt: now } });
            await this.telegram?.sendMessage(
              routine.owner.telegramId,
              `Регламент «${routine.title}» упёрся в недельный лимит токенов (${routine.weeklyTokenCap.toLocaleString('ru-RU')}) и не запускается. Поднимите лимит или подождите — лимит считается за последние 7 дней.`,
            );
          }
          return;
        }
      }

      const user: AuthenticatedUser = { id: routine.owner.id, email: routine.owner.email, role: routine.owner.role };
      const call: RoutineCall = routine.skill && !routine.prompt
        ? {
            model: SKILL_MODEL_IDS[routine.skill.model],
            effort: SKILL_EFFORT_VALUES[routine.skill.effort],
            maxTokens: SKILL_MAX_TOKENS[routine.skill.model],
            instructions: routine.skill.instructions,
            allowedTools: routine.skill.allowedTools,
          }
        : { model: ROUTINE_PROMPT_MODEL, effort: ROUTINE_PROMPT_EFFORT, maxTokens: ROUTINE_PROMPT_MAX_TOKENS, instructions: routine.prompt ?? '', allowedTools: null };
      const passive = routine.mode === RoutineMode.PASSIVE;
      const outcome = await this.runAgent(user, { id: routine.id, title: routine.title, passive }, call, run.id);
      const usage = { tokensIn: outcome.tokensIn, tokensOut: outcome.tokensOut, costUsd: outcome.costUsd };

      const message = passive ? noticesToMarkdown(outcome.notices) : outcome.text;
      if (!message) {
        await this.finish(run.id, RoutineRunStatus.SILENT, usage);
        await this.prisma.routine.update({ where: { id: routine.id }, data: { lastRunAt: now } });
        return;
      }
      const conversationId = await this.deliver(routine, message, now);
      await this.finish(run.id, RoutineRunStatus.DONE, { ...usage, summary: runSummary(message), conversationId });
      await this.prisma.routine.update({ where: { id: routine.id }, data: { lastRunAt: now } });
    } catch (err) {
      this.logger.error(`routine run ${run.id} failed (attempt ${run.attempts}): ${errorText(err)}`);
      if (run.attempts >= MAX_ATTEMPTS) await this.finish(run.id, RoutineRunStatus.FAILED, { error: 'Не удалось выполнить регламент' });
      else await this.prisma.routineRun.update({ where: { id: run.id }, data: { status: RoutineRunStatus.QUEUED, lockedAt: null } });
    }
  }

  // Цикл модели: только читающие инструменты (+ notify_owner в пассивном
  // режиме), ограничение по раундам. Память и тон — как в чате.
  async runAgent(user: AuthenticatedUser, routine: { id: string; title: string; passive: boolean }, call: RoutineCall, runId: string): Promise<RoutineOutcome> {
    const [allTools, memoryIndex, tone] = await Promise.all([this.tools.buildTools(user), this.loadMemory(user), this.loadTone(user)]);
    const tools = routineTools(allTools, isWriteTool, call.allowedTools, routine.passive);
    const cache = { type: 'ephemeral' as const, ttl: '1h' as const };
    const personal = [memoryIndex, tone].filter((b): b is string => !!b).join('\n\n');
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: ROUTINE_SYSTEM, cache_control: cache },
      ...(personal ? [{ type: 'text' as const, text: personal, cache_control: cache }] : []),
      { type: 'text', text: buildRoutineBlock({ title: routine.title, instructions: call.instructions, passive: routine.passive }) },
    ];
    let messages: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: buildDateContext() }, { type: 'text', text: 'Выполни регламент.' }] },
    ];
    const outcome: RoutineOutcome = { text: '', notices: [], tokensIn: 0, tokensOut: 0, costUsd: 0 };

    for (let round = 0; ; round++) {
      const response = await trackedCreate(
        this.aiUsage,
        `routine.run:${routine.id}`,
        this.getClient(),
        {
          model: call.model,
          max_tokens: call.maxTokens,
          output_config: { effort: call.effort },
          system,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        },
        { routineId: routine.id, runId },
      );
      const tokens = usageTokens(response.usage);
      outcome.tokensIn += tokens.tokensIn;
      outcome.tokensOut += tokens.tokensOut;
      outcome.costUsd +=
        callCostUsd({
          model: call.model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? null,
          cacheWrite1hTokens: response.usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
        }) ?? 0;

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0 || round >= ROUTINE_MAX_TOOL_ROUNDS) {
        outcome.text = extractText(response.content);
        return outcome;
      }
      const results = await Promise.all(
        toolUses.map(async (block): Promise<Anthropic.ToolResultBlockParam> => {
          if (block.name === NOTIFY_TOOL_NAME) {
            const notice = routine.passive ? parseNotify(block.input) : null;
            if (notice) outcome.notices.push(notice);
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(notice ? { delivered: true } : { error: 'EMPTY_TEXT' }), is_error: !notice };
          }
          // Модель — не граница безопасности: вне выданного списка не исполняем.
          if (!tools.some((t) => t.name === block.name)) {
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ error: 'TOOL_NOT_ALLOWED' }), is_error: true };
          }
          const result = await this.tools.execute(block.name, block.input, user);
          return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(toolResultForModel(result)), is_error: 'error' in result };
        }),
      );
      messages = [...messages, { role: 'assistant', content: response.content }, { role: 'user', content: results }];
    }
  }

  // FEED — отдельный разговор в ассистенте; TELEGRAM — боту. Нет Telegram —
  // результат всё равно в ленте, чтобы не потерять.
  private async deliver(
    routine: { id: string; title: string; ownerId: string; channel: RoutineChannel; owner: { telegramId: string | null } },
    markdown: string,
    at: Date,
  ): Promise<string | null> {
    const toTelegram = (routine.channel === RoutineChannel.TELEGRAM || routine.channel === RoutineChannel.BOTH) && !!this.telegram && !!routine.owner.telegramId;
    const toFeed = routine.channel !== RoutineChannel.TELEGRAM || !toTelegram;
    let conversationId: string | null = null;
    if (toFeed) {
      conversationId = await this.prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.create({ data: { employeeId: routine.ownerId, title: feedTitle(routine.title, at) } });
        const question = await tx.message.create({
          data: {
            conversationId: conversation.id,
            role: MessageRole.USER,
            parts: { create: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: `Регламент «${routine.title}»` } }] },
          },
        });
        await tx.message.create({
          data: {
            conversationId: conversation.id,
            role: MessageRole.ASSISTANT,
            replyToMessageId: question.id,
            parts: { create: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: markdown } }] },
          },
        });
        return conversation.id;
      });
    }
    if (toTelegram) {
      await this.telegram?.sendMessage(routine.owner.telegramId, clipForTelegram(`${routine.title}\n\n${markdownToTelegramText(markdown)}`));
    }
    return conversationId;
  }

  private async finish(
    runId: string,
    status: RoutineRunStatus,
    data: { error?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; summary?: string; conversationId?: string | null } = {},
  ): Promise<void> {
    await this.prisma.routineRun.update({ where: { id: runId }, data: { status, ...data, lockedAt: null, finishedAt: new Date() } });
  }

  private async loadMemory(user: AuthenticatedUser): Promise<string | null> {
    if (!this.memory) return null;
    try {
      return await this.memory.buildIndex(user.id);
    } catch (err) {
      this.logger.warn(`memory index failed: ${errorText(err)}`);
      return null;
    }
  }

  private async loadTone(user: AuthenticatedUser): Promise<string | null> {
    if (!this.skills) return null;
    try {
      return await this.skills.toneBlock(user);
    } catch (err) {
      this.logger.warn(`tone block failed: ${errorText(err)}`);
      return null;
    }
  }
}

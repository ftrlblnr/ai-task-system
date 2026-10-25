import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, Routine, RoutineChannel, RoutineMode, RoutineRun, RoutineRunStatus, RoutineRunTrigger, RoutineState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from '../skills/skills.service';
import { buildSimpleCron, nextRunAfter, parseSimpleCron } from './routine-schedule';
import { ROUTINE_PROMPT_MAX, ROUTINE_TITLE_MAX, SYSTEM_CRONS, WEEK_MS } from './routine-catalog';

export interface RoutineInputData {
  title: string;
  skillId?: string | null;
  prompt?: string | null;
  days: number[];
  time: string;
  mode: RoutineMode;
  channel: RoutineChannel;
  weeklyTokenCap?: number | null;
}

export type RoutinePatch = Partial<RoutineInputData> & { state?: 'ACTIVE' | 'PAUSED' };

type RoutineWithSkill = Routine & { skill: { id: string; slug: string; title: string } | null };

const MIN_TOKEN_CAP = 1000;
// За один проход планировщика — не больше стольких регламентов (остальные — через минуту).
const SCHEDULE_BATCH = 20;

export function runView(r: RoutineRun) {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    slot: r.slot?.toISOString() ?? null,
    tokens: r.tokensIn + r.tokensOut,
    costUsd: r.costUsd,
    summary: r.summary,
    conversationId: r.conversationId,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

function routineView(r: RoutineWithSkill, week: { runs: number; tokens: number; costUsd: number }, lastRun: RoutineRun | null) {
  const simple = parseSimpleCron(r.schedule);
  return {
    id: r.id,
    title: r.title,
    skill: r.skill,
    prompt: r.prompt,
    schedule: r.schedule,
    days: simple?.days ?? null,
    time: simple?.time ?? null,
    mode: r.mode,
    channel: r.channel,
    weeklyTokenCap: r.weeklyTokenCap,
    state: r.state,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    week,
    lastRun: lastRun ? runView(lastRun) : null,
  };
}

// Регламенты (ARMS, фаза 4): хранение, планировщик слотов, запуск по
// кнопке. Сам прогон — assistant/routine-run-execution.service.ts (ему
// нужны инструменты ассистента, а ассистент зависит от этого модуля).
@Injectable()
export class RoutinesService {
  private readonly logger = new Logger(RoutinesService.name);
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
  ) {}

  async overview(userId: string) {
    const routines = await this.prisma.routine.findMany({
      where: { ownerId: userId },
      include: { skill: { select: { id: true, slug: true, title: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const ids = routines.map((r) => r.id);
    const since = new Date(Date.now() - WEEK_MS);
    const [week, lastRuns] = await Promise.all([
      this.prisma.routineRun.groupBy({
        by: ['routineId'],
        where: { routineId: { in: ids }, createdAt: { gte: since }, status: { notIn: [RoutineRunStatus.QUEUED, RoutineRunStatus.SKIPPED_CAP] } },
        _count: { _all: true },
        _sum: { tokensIn: true, tokensOut: true, costUsd: true },
      }),
      this.prisma.routineRun.findMany({ where: { routineId: { in: ids } }, orderBy: { createdAt: 'desc' }, distinct: ['routineId'] }),
    ]);
    const weekBy = new Map(week.map((w) => [w.routineId, { runs: w._count._all, tokens: (w._sum.tokensIn ?? 0) + (w._sum.tokensOut ?? 0), costUsd: w._sum.costUsd ?? 0 }]));
    const lastBy = new Map(lastRuns.map((r) => [r.routineId, r]));
    return {
      routines: routines.map((r) => routineView(r, weekBy.get(r.id) ?? { runs: 0, tokens: 0, costUsd: 0 }, lastBy.get(r.id) ?? null)),
      systemCrons: SYSTEM_CRONS,
    };
  }

  async runs(userId: string, id: string) {
    await this.findOwn(userId, id);
    const runs = await this.prisma.routineRun.findMany({ where: { routineId: id }, orderBy: { createdAt: 'desc' }, take: 30 });
    return runs.map(runView);
  }

  async create(userId: string, input: RoutineInputData) {
    const data = await this.normalize(userId, input);
    const created = await this.prisma.routine.create({
      data: { ...data, ownerId: userId, state: RoutineState.ACTIVE, nextRunAt: data.schedule ? nextRunAfter(data.schedule, new Date()) : null },
    });
    return this.viewOf(userId, created.id);
  }

  async update(userId: string, id: string, patch: RoutinePatch) {
    const current = await this.findOwn(userId, id);
    const merged: RoutineInputData = {
      title: patch.title ?? current.title,
      skillId: patch.skillId !== undefined || patch.prompt !== undefined ? (patch.skillId ?? null) : current.skillId,
      prompt: patch.skillId !== undefined || patch.prompt !== undefined ? (patch.prompt ?? null) : current.prompt,
      days: patch.days ?? parseSimpleCron(current.schedule)?.days ?? [],
      time: patch.time ?? parseSimpleCron(current.schedule)?.time ?? '09:00',
      mode: patch.mode ?? current.mode,
      channel: patch.channel ?? current.channel,
      weeklyTokenCap: patch.weeklyTokenCap !== undefined ? patch.weeklyTokenCap : current.weeklyTokenCap,
    };
    // Сложный cron (не из формы) сохраняем как есть, пока не правят дни/время.
    const keepSchedule = patch.days === undefined && patch.time === undefined && current.schedule && !parseSimpleCron(current.schedule);
    const data = await this.normalize(userId, merged);
    if (keepSchedule) data.schedule = current.schedule;
    const state = patch.state ? RoutineState[patch.state] : current.state;
    // Включение черновика — тоже здесь (state: ACTIVE).
    const nextRunAt = state === RoutineState.ACTIVE && data.schedule ? nextRunAfter(data.schedule, new Date()) : null;
    await this.prisma.routine.update({ where: { id }, data: { ...data, state, nextRunAt } });
    return this.viewOf(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.findOwn(userId, id);
    await this.prisma.routine.delete({ where: { id } });
  }

  async enqueueRun(userId: string, id: string, clientRequestId?: string) {
    const routine = await this.findOwn(userId, id);
    if (routine.state === RoutineState.DRAFT) throw new BadRequestException('Сначала включите регламент');
    const idempotencyKey = clientRequestId ? `button:${userId}:${clientRequestId}` : null;
    try {
      return await this.prisma.routineRun.create({ data: { routineId: id, trigger: RoutineRunTrigger.BUTTON, idempotencyKey } });
    } catch (err) {
      if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.routineRun.findUnique({ where: { idempotencyKey } });
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getRun(userId: string, runId: string) {
    const run = await this.prisma.routineRun.findFirst({ where: { id: runId, routine: { ownerId: userId } } });
    if (!run) throw new NotFoundException('Запуск не найден');
    return run;
  }

  // propose_routine из чата: черновик, который включает человек. Повтор того
  // же вызова (ретрай ответа) возвращает тот же черновик.
  async proposeDraft(userId: string, input: RoutineInputData, sourceKey: string) {
    const existing = await this.prisma.routine.findUnique({ where: { sourceKey } });
    if (existing) return existing;
    const data = await this.normalize(userId, input);
    try {
      return await this.prisma.routine.create({ data: { ...data, ownerId: userId, state: RoutineState.DRAFT, sourceKey } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.routine.findUnique({ where: { sourceKey } });
        if (raced) return raced;
      }
      throw err;
    }
  }

  // Планировщик: наступившие слоты → RoutineRun (unique по слоту — повторно
  // слот не встанет), nextRunAt — следующий слот после «сейчас»: пропущенные
  // за время простоя слоты не догоняем, выполняется только последний.
  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleDue(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        const due = await tx.$queryRaw<{ id: string; schedule: string; nextRunAt: Date }[]>`
          SELECT "id", "schedule", "nextRunAt" FROM "Routine"
           WHERE "state" = 'ACTIVE' AND "schedule" IS NOT NULL AND "nextRunAt" <= ${now}
           ORDER BY "nextRunAt" ASC LIMIT ${SCHEDULE_BATCH}
           FOR UPDATE SKIP LOCKED`;
        for (const r of due) {
          await tx.routineRun.createMany({ data: [{ routineId: r.id, trigger: RoutineRunTrigger.SCHEDULE, slot: r.nextRunAt }], skipDuplicates: true });
          await tx.routine.update({ where: { id: r.id }, data: { nextRunAt: nextRunAfter(r.schedule, now) } });
        }
      });
    } catch (err) {
      this.logger.error(`routine scheduling failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async findOwn(userId: string, id: string): Promise<Routine> {
    const routine = await this.prisma.routine.findFirst({ where: { id, ownerId: userId } });
    if (!routine) throw new NotFoundException('Регламент не найден');
    return routine;
  }

  private async viewOf(userId: string, id: string) {
    const { routines } = await this.overview(userId);
    const view = routines.find((r) => r.id === id);
    if (!view) throw new NotFoundException('Регламент не найден');
    return view;
  }

  // Ровно одно из двух: навык (видимый пользователю, не в архиве) или своя инструкция.
  private async normalize(userId: string, input: RoutineInputData) {
    const title = input.title?.trim() ?? '';
    if (title.length < 2 || title.length > ROUTINE_TITLE_MAX) throw new BadRequestException('Название — от 2 до 80 символов');
    const prompt = input.prompt?.trim() || null;
    const skillId = input.skillId || null;
    if (!!prompt === !!skillId) throw new BadRequestException('Выберите навык или напишите инструкцию');
    if (prompt && (prompt.length < 10 || prompt.length > ROUTINE_PROMPT_MAX)) throw new BadRequestException('Инструкция — от 10 символов');
    if (skillId) {
      const skill = await this.skills.findVisible(userId, skillId);
      if (!skill.enabled) throw new BadRequestException('Навык в архиве');
    }
    let schedule: string | null = null;
    if (input.days.length > 0) {
      schedule = buildSimpleCron({ days: input.days, time: input.time });
      if (!schedule) throw new BadRequestException('Неверное расписание');
    }
    // 0 в форме — «без лимита».
    const cap = input.weeklyTokenCap || null;
    if (cap !== null && (!Number.isInteger(cap) || cap < MIN_TOKEN_CAP)) throw new BadRequestException(`Лимит — от ${MIN_TOKEN_CAP} токенов`);
    return { title, prompt, skillId, schedule, mode: input.mode, channel: input.channel, weeklyTokenCap: cap };
  }
}

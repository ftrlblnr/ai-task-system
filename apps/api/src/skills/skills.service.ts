import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  Prisma,
  Skill,
  SkillEffort,
  SkillFeedback,
  SkillKind,
  SkillModel,
  SkillOutput,
  SkillRevisionSource,
  SkillRevisionStatus,
  SkillRunStatus,
  SkillRunTrigger,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { isManager } from '../auth/roles';
import {
  buildMarkdownDocx,
  docxFileName,
  DOCX_MIME,
} from '../reports/markdown-docx';
import { callCostUsd } from '../ai-usage/ai-usage-prices';
import {
  buildToneBlock,
  parseSkillInvocation,
  pickSkillUpgrades,
  SKILL_TOOL_LABELS,
  skillUserText,
  SYSTEM_SKILLS,
  TONE_SLUG,
} from './skill-catalog';

// Навык в том виде, в каком его получает AssistantReplyService.
export interface ReplySkill {
  id: string;
  slug: string;
  title: string;
  instructions: string;
  model: SkillModel;
  effort: SkillEffort;
  allowedTools: string[];
  output: SkillOutput;
}

// Ответ навыка в ленте: под ним 👍/👎.
export interface SkillRunView {
  id: string;
  skillId: string;
  slug: string;
  title: string;
  feedback: SkillFeedback | null;
}

export interface SkillInput {
  slug?: string;
  title?: string;
  description?: string;
  kind?: SkillKind;
  instructions?: string;
  model?: SkillModel;
  effort?: SkillEffort;
  allowedTools?: string[];
  output?: SkillOutput;
  enabled?: boolean;
}

const RUN_ERROR_MAX = 500;

function toReplySkill(s: Skill): ReplySkill {
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    instructions: s.instructions,
    model: s.model,
    effort: s.effort,
    allowedTools: s.allowedTools,
    output: s.output,
  };
}

function cleanTools(tools: string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  return [...new Set(tools.filter((t) => t in SKILL_TOOL_LABELS))];
}

@Injectable()
export class SkillsService implements OnModuleInit {
  private readonly logger = new Logger(SkillsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedSystemSkills();
    } catch (err) {
      this.logger.warn(
        `seed навыков не удался: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Недостающие создаём; существующий общий навык обновляем до нового seed
  // только если его никто не правил (текст и инструменты — дословно прежний
  // seed, SYSTEM_SKILL_UPGRADES). Правки людей не трогаем. version растёт —
  // предложения правок, сделанные от старого текста, становятся устаревшими.
  async seedSystemSkills(): Promise<number> {
    const existing = await this.prisma.skill.findMany({
      where: { ownerId: null },
      select: { id: true, slug: true, instructions: true, allowedTools: true },
    });
    const have = new Set(existing.map((s) => s.slug));
    const missing = SYSTEM_SKILLS.filter((s) => !have.has(s.slug));
    for (const s of missing)
      await this.prisma.skill.create({ data: { ...s, ownerId: null } });
    for (const upgrade of pickSkillUpgrades(existing)) {
      await this.prisma.skill.update({
        where: { id: upgrade.id },
        data: {
          instructions: upgrade.seed.instructions,
          allowedTools: upgrade.seed.allowedTools,
          version: { increment: 1 },
        },
      });
      this.logger.log(
        `общий навык /${upgrade.seed.slug} обновлён до нового seed`,
      );
    }
    return missing.length;
  }

  private visibleWhere(userId: string): Prisma.SkillWhereInput {
    return { OR: [{ ownerId: null }, { ownerId: userId }] };
  }

  // Чужой личный навык — 404, как и несуществующий.
  async findVisible(userId: string, id: string): Promise<Skill> {
    const skill = await this.prisma.skill.findFirst({
      where: { id, ...this.visibleWhere(userId) },
    });
    if (!skill) throw new NotFoundException('Навык не найден');
    return skill;
  }

  async list(userId: string) {
    const skills = await this.prisma.skill.findMany({
      where: this.visibleWhere(userId),
      orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
    });
    const since = new Date(Date.now() - 30 * 86400_000);
    const ids = skills.map((s) => s.id);
    const [runs, pending] = await Promise.all([
      this.prisma.skillRun.groupBy({
        by: ['skillId'],
        where: {
          skillId: { in: ids },
          ownerId: userId,
          createdAt: { gte: since },
        },
        _count: { _all: true },
      }),
      this.prisma.skillRevision.groupBy({
        by: ['skillId'],
        where: { skillId: { in: ids }, status: SkillRevisionStatus.PROPOSED },
        _count: { _all: true },
      }),
    ]);
    const runCount = new Map(runs.map((r) => [r.skillId, r._count._all]));
    const pendingCount = new Map(
      pending.map((r) => [r.skillId, r._count._all]),
    );
    return skills.map((s) => ({
      ...s,
      runs30d: runCount.get(s.id) ?? 0,
      pendingRevisions: pendingCount.get(s.id) ?? 0,
    }));
  }

  // Страница навыка: версии, отзывы, расход за 30 дней.
  async detail(userId: string, id: string) {
    const skill = await this.findVisible(userId, id);
    const since = new Date(Date.now() - 30 * 86400_000);
    const [revisions, feedback, runs30d, calls] = await Promise.all([
      this.prisma.skillRevision.findMany({
        where: { skillId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.skillRun.findMany({
        where: { skillId: id, ownerId: userId, feedback: { not: null } },
        orderBy: { feedbackAt: 'desc' },
        take: 20,
        select: {
          id: true,
          feedback: true,
          feedbackText: true,
          feedbackAt: true,
          inputText: true,
          conversationId: true,
        },
      }),
      this.prisma.skillRun.count({
        where: { skillId: id, ownerId: userId, createdAt: { gte: since } },
      }),
      this.prisma.aiCall.findMany({
        where: {
          createdAt: { gte: since },
          meta: { path: ['skillId'], equals: id },
        },
        select: {
          model: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          cacheWrite1hTokens: true,
        },
      }),
    ]);
    const costUsd = calls.reduce((sum, c) => sum + (callCostUsd(c) ?? 0), 0);
    return {
      skill,
      revisions,
      feedback,
      stats: { runs30d, calls30d: calls.length, costUsd30d: costUsd },
    };
  }

  async create(
    userId: string,
    input: Required<
      Pick<
        SkillInput,
        | 'slug'
        | 'title'
        | 'description'
        | 'kind'
        | 'instructions'
        | 'model'
        | 'effort'
      >
    > &
      SkillInput,
  ) {
    const slug = input.slug.trim().toLowerCase();
    const clash = await this.prisma.skill.findFirst({
      where: { slug, ...this.visibleWhere(userId) },
      select: { id: true },
    });
    if (clash)
      throw new ConflictException('Навык с таким названием команды уже есть');
    return this.prisma.skill.create({
      data: {
        ownerId: userId,
        slug,
        title: input.title.trim(),
        description: input.description.trim(),
        kind: input.kind,
        instructions: input.instructions.trim(),
        model: input.model,
        effort: input.effort,
        allowedTools: cleanTools(input.allowedTools) ?? [],
        output: input.output ?? SkillOutput.CHAT,
      },
    });
  }

  // slug не меняется: по нему вызывают и считают расход. Смена инструкции —
  // новая версия и строка в истории.
  async update(userId: string, id: string, input: SkillInput): Promise<Skill> {
    const skill = await this.findVisible(userId, id);
    const instructions = input.instructions?.trim();
    const instructionsChanged =
      instructions !== undefined && instructions !== skill.instructions;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.skill.update({
        where: { id },
        data: {
          title: input.title?.trim(),
          description: input.description?.trim(),
          kind: input.kind,
          model: input.model,
          effort: input.effort,
          allowedTools: cleanTools(input.allowedTools),
          output: input.output,
          enabled: input.enabled,
          ...(instructionsChanged
            ? { instructions, version: { increment: 1 } }
            : {}),
        },
      });
      if (instructionsChanged) {
        await tx.skillRevision.create({
          data: {
            skillId: id,
            source: SkillRevisionSource.MANUAL,
            status: SkillRevisionStatus.APPLIED,
            baseVersion: skill.version,
            instructions,
            reason: 'Правка вручную',
            createdById: userId,
            decidedAt: new Date(),
          },
        });
      }
      return updated;
    });
  }

  // Удалить можно только свой навык; общий — только в архив.
  async remove(userId: string, id: string): Promise<void> {
    const skill = await this.findVisible(userId, id);
    if (skill.ownerId !== userId)
      throw new BadRequestException(
        'Общий навык нельзя удалить — уберите его в архив',
      );
    await this.prisma.skill.delete({ where: { id } });
  }

  // «/slug текст» в начале сообщения → навык (свой важнее общего). Только
  // руководству; выключенный или неизвестный — обычное сообщение.
  async resolveInvocation(
    user: AuthenticatedUser,
    text: string,
  ): Promise<{ skill: ReplySkill; text: string; rest: string } | null> {
    if (!isManager(user.role)) return null;
    const parsed = parseSkillInvocation(text);
    if (!parsed) return null;
    const candidates = await this.prisma.skill.findMany({
      where: {
        slug: parsed.slug,
        enabled: true,
        ...this.visibleWhere(user.id),
      },
    });
    const skill =
      candidates.find((s) => s.ownerId === user.id) ?? candidates[0];
    if (!skill) return null;
    return {
      skill: toReplySkill(skill),
      text: skillUserText(parsed.rest),
      rest: parsed.rest,
    };
  }

  async toneBlock(user: AuthenticatedUser): Promise<string | null> {
    if (!isManager(user.role)) return null;
    return (await this.toneFor(user.id)).block;
  }

  // Стиль конкретного сотрудника: личный /тон, иначе общий. Разбор почты
  // зовёт это по владельцу ящика, а не по тому, кто нажал (ADMIN в режиме
  // X-Act-As пишет черновик в стиле руководителя). Без роли: ящик подключают
  // только руководитель и администратор, проверка — в почтовом модуле.
  // block null (пусто, заглушка, архив) — version тоже null: «стиля нет».
  async toneFor(employeeId: string): Promise<{
    block: string | null;
    version: number | null;
    skillId: string | null;
  }> {
    const candidates = await this.prisma.skill.findMany({
      where: {
        slug: TONE_SLUG,
        enabled: true,
        ...this.visibleWhere(employeeId),
      },
      select: { id: true, ownerId: true, instructions: true, version: true },
    });
    const tone =
      candidates.find((s) => s.ownerId === employeeId) ??
      candidates.find((s) => s.ownerId === null);
    if (!tone) return { block: null, version: null, skillId: null };
    const block = buildToneBlock(tone.instructions);
    return { block, version: block ? tone.version : null, skillId: tone.id };
  }

  // Итог запуска: из чата — новая строка, кнопкой — обновление созданной
  // при постановке в очередь.
  async recordRun(input: {
    skill: ReplySkill;
    ownerId: string;
    runId?: string;
    inputText: string;
    conversationId: string;
    outputMessageId: string | null;
    ok: boolean;
    error?: string;
  }): Promise<SkillRunView> {
    const data = {
      status: input.ok ? SkillRunStatus.SUCCEEDED : SkillRunStatus.FAILED,
      conversationId: input.conversationId,
      outputMessageId: input.outputMessageId,
      error: input.error?.slice(0, RUN_ERROR_MAX) ?? null,
      finishedAt: new Date(),
    };
    const create = {
      ...data,
      skillId: input.skill.id,
      ownerId: input.ownerId,
      trigger: SkillRunTrigger.CHAT,
      inputText: input.inputText,
      startedAt: new Date(),
    };
    const run = input.runId
      ? await this.prisma.skillRun.update({ where: { id: input.runId }, data })
      : input.outputMessageId
        ? // Повтор того же ответа (ретрай сообщения) — та же строка.
          await this.prisma.skillRun.upsert({
            where: { outputMessageId: input.outputMessageId },
            update: data,
            create,
          })
        : await this.prisma.skillRun.create({ data: create });
    return {
      id: run.id,
      skillId: input.skill.id,
      slug: input.skill.slug,
      title: input.skill.title,
      feedback: run.feedback,
    };
  }

  async failRun(
    runId: string,
    error: string,
    conversationId?: string,
    outputMessageId?: string,
  ): Promise<void> {
    await this.prisma.skillRun.update({
      where: { id: runId },
      data: {
        status: SkillRunStatus.FAILED,
        error: error.slice(0, RUN_ERROR_MAX),
        conversationId,
        outputMessageId,
        lockedAt: null,
        finishedAt: new Date(),
      },
    });
  }

  async runViewsForMessages(
    messageIds: string[],
  ): Promise<Map<string, SkillRunView>> {
    if (messageIds.length === 0) return new Map();
    const runs = await this.prisma.skillRun.findMany({
      where: { outputMessageId: { in: messageIds } },
      select: {
        id: true,
        outputMessageId: true,
        feedback: true,
        skill: { select: { id: true, slug: true, title: true } },
      },
    });
    return new Map(
      runs.map((r) => [
        r.outputMessageId as string,
        {
          id: r.id,
          skillId: r.skill.id,
          slug: r.skill.slug,
          title: r.skill.title,
          feedback: r.feedback,
        },
      ]),
    );
  }

  async feedback(
    userId: string,
    runId: string,
    value: SkillFeedback,
    text?: string,
  ): Promise<SkillRunView> {
    const run = await this.prisma.skillRun.findFirst({
      where: { id: runId, ownerId: userId },
      include: { skill: { select: { id: true, slug: true, title: true } } },
    });
    if (!run) throw new NotFoundException('Запуск навыка не найден');
    const updated = await this.prisma.skillRun.update({
      where: { id: runId },
      data: {
        feedback: value,
        feedbackText: text?.trim() || null,
        feedbackAt: new Date(),
      },
    });
    return {
      id: run.id,
      skillId: run.skill.id,
      slug: run.skill.slug,
      title: run.skill.title,
      feedback: updated.feedback,
    };
  }

  // ▶ — запуск без чата: фоновая задача (SkillRunExecutionService).
  async enqueueRun(
    userId: string,
    skillId: string,
    inputText: string,
    clientRequestId?: string,
  ) {
    const skill = await this.findVisible(userId, skillId);
    if (!skill.enabled) throw new BadRequestException('Навык в архиве');
    const idempotencyKey = clientRequestId
      ? `button:${userId}:${clientRequestId}`
      : null;
    try {
      return await this.prisma.skillRun.create({
        data: {
          skillId,
          ownerId: userId,
          trigger: SkillRunTrigger.BUTTON,
          status: SkillRunStatus.QUEUED,
          inputText: inputText.trim(),
          idempotencyKey,
        },
      });
    } catch (err) {
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.skillRun.findUnique({
          where: { idempotencyKey },
        });
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getRun(userId: string, runId: string) {
    const run = await this.prisma.skillRun.findFirst({
      where: { id: runId, ownerId: userId },
    });
    if (!run) throw new NotFoundException('Запуск навыка не найден');
    return run;
  }

  // «Обучить навык» (по отзывам) и «Собрать из писем» (/тон) — предложение
  // генерирует фоновая задача; применяет только человек.
  async requestRevision(
    userId: string,
    skillId: string,
    source: 'FEEDBACK' | 'SENT_MAIL',
  ) {
    const skill = await this.findVisible(userId, skillId);
    if (source === 'SENT_MAIL' && skill.slug !== TONE_SLUG)
      throw new BadRequestException('Собрать из писем можно только тон');
    if (source === 'FEEDBACK') {
      const count = await this.prisma.skillRun.count({
        where: { skillId, feedback: { not: null } },
      });
      if (count === 0)
        throw new BadRequestException(
          'Пока нет отзывов — оцените ответы навыка 👍/👎',
        );
    }
    const busy = await this.prisma.skillRevision.findFirst({
      where: { skillId, status: SkillRevisionStatus.GENERATING },
      select: { id: true },
    });
    if (busy) throw new ConflictException('Предложение уже готовится');
    return this.prisma.skillRevision.create({
      data: {
        skillId,
        source:
          source === 'FEEDBACK'
            ? SkillRevisionSource.FEEDBACK
            : SkillRevisionSource.SENT_MAIL,
        status: SkillRevisionStatus.GENERATING,
        baseVersion: skill.version,
        createdById: userId,
      },
    });
  }

  // Рекомендация (ARMS, фаза 5) с готовой инструкцией — сразу PROPOSED:
  // человек смотрит дифф на странице навыка и применяет сам.
  async proposeRevision(
    userId: string,
    skillId: string,
    instructions: string,
    reason: string,
  ) {
    const skill = await this.findVisible(userId, skillId);
    return this.prisma.skillRevision.create({
      data: {
        skillId,
        source: SkillRevisionSource.RECOMMENDATION,
        status: SkillRevisionStatus.PROPOSED,
        baseVersion: skill.version,
        instructions: instructions.trim(),
        reason,
        createdById: userId,
      },
    });
  }

  private async findOwnRevision(userId: string, revisionId: string) {
    const revision = await this.prisma.skillRevision.findUnique({
      where: { id: revisionId },
    });
    if (!revision) throw new NotFoundException('Предложение не найдено');
    await this.findVisible(userId, revision.skillId);
    return revision;
  }

  // Применение — только если навык с тех пор не меняли: иначе предложение
  // перезаписало бы чужую правку.
  async applyRevision(userId: string, revisionId: string): Promise<Skill> {
    const revision = await this.findOwnRevision(userId, revisionId);
    if (
      revision.status !== SkillRevisionStatus.PROPOSED ||
      !revision.instructions
    )
      throw new BadRequestException('Предложение уже рассмотрено');
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.skill.updateMany({
        where: { id: revision.skillId, version: revision.baseVersion },
        data: {
          instructions: revision.instructions as string,
          version: { increment: 1 },
        },
      });
      if (changed.count === 0)
        throw new ConflictException(
          'Навык изменили после предложения — запросите новое',
        );
      await tx.skillRevision.update({
        where: { id: revisionId },
        data: {
          status: SkillRevisionStatus.APPLIED,
          decidedAt: new Date(),
          createdById: userId,
        },
      });
      return tx.skill.findUniqueOrThrow({ where: { id: revision.skillId } });
    });
  }

  async rejectRevision(userId: string, revisionId: string): Promise<void> {
    const revision = await this.findOwnRevision(userId, revisionId);
    if (revision.status !== SkillRevisionStatus.PROPOSED)
      throw new BadRequestException('Предложение уже рассмотрено');
    await this.prisma.skillRevision.update({
      where: { id: revisionId },
      data: { status: SkillRevisionStatus.REJECTED, decidedAt: new Date() },
    });
  }

  // output=DOCX: ответ навыка → файл Word в той же реплике.
  async renderDocx(ownerId: string, skill: ReplySkill, markdown: string) {
    const createdAt = new Date();
    const buffer = await buildMarkdownDocx(markdown, {
      title: skill.title,
      createdAt,
    });
    const file = await this.files.createGeneratedForEmployee(
      ownerId,
      buffer,
      docxFileName(skill.title, createdAt),
      DOCX_MIME,
    );
    return {
      fileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
    };
  }
}

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MessagePartType, MessageStatus, Prisma, SkillRun, SkillRunStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { isManager } from '../auth/roles';
import { AssistantChatService, type MessageWithParts } from './assistant-chat.service';

// ARMS, фаза 3 — ▶ навыка без открытия чата («self-triggered skills»).
// Тот же durable-приём, что разборы договоров: строка SkillRun + @Cron +
// claim SKIP LOCKED. Исполнение — обычным сообщением «/slug …» в новом
// разговоре через AssistantChatService (тот же путь, что чат: инструменты,
// права, журнал), результат — ещё и в Telegram.

const LOCK_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 2;
const TELEGRAM_MAX = 3800;

// Telegram без parse_mode: markdown — в читаемый простой текст.
export function markdownToTelegramText(markdown: string): string {
  return markdown
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+(.*)$/gm, (_, t: string) => t.toUpperCase())
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function clipForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX) return text;
  return `${text.slice(0, TELEGRAM_MAX).replace(/\s+\S*$/, '')}…\n\nПолностью — в ассистенте Адъютанта.`;
}

function runTitle(slug: string, at: Date): string {
  const when = at.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `/${slug} · ${when}`;
}

@Injectable()
export class SkillRunExecutionService {
  private readonly logger = new Logger(SkillRunExecutionService.name);
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: AssistantChatService,
    @Optional() private readonly telegram?: TelegramBotService,
  ) {}

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

  async claimOne(): Promise<SkillRun | null> {
    const now = new Date();
    const threshold = new Date(now.getTime() - LOCK_TTL_MS);
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "SkillRun"
          WHERE "attempts" < ${MAX_ATTEMPTS}
            AND ("status" = 'QUEUED' OR ("status" = 'RUNNING' AND "lockedAt" < ${threshold}))
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      if (locked.length === 0) {
        // Брошенные без попыток — FAILED, иначе висели бы RUNNING вечно.
        await tx.skillRun.updateMany({
          where: { status: SkillRunStatus.RUNNING, attempts: { gte: MAX_ATTEMPTS }, lockedAt: { lt: threshold } },
          data: { status: SkillRunStatus.FAILED, error: 'Не удалось выполнить навык', lockedAt: null, finishedAt: now },
        });
        return null;
      }
      return tx.skillRun.update({
        where: { id: locked[0].id },
        data: { status: SkillRunStatus.RUNNING, lockedAt: now, attempts: { increment: 1 }, startedAt: now, error: null },
      });
    });
  }

  async process(run: SkillRun): Promise<void> {
    try {
      const [skill, owner] = await Promise.all([
        this.prisma.skill.findUnique({ where: { id: run.skillId } }),
        this.prisma.employee.findUnique({ where: { id: run.ownerId }, select: { id: true, email: true, role: true, status: true, telegramId: true } }),
      ]);
      // Права — на момент исполнения, не постановки в очередь.
      if (!skill || !owner || owner.status !== 'ACTIVE' || !isManager(owner.role)) {
        await this.fail(run.id, 'Навык недоступен');
        return;
      }
      const user = { id: owner.id, email: owner.email, role: owner.role };
      const conversationId = run.conversationId ?? (await this.openConversation(run, skill.slug));
      const text = `/${skill.slug}${run.inputText ? ` ${run.inputText}` : ''}`;
      // clientRequestId — повтор после сбоя продолжает ту же пару сообщений.
      const { assistantMessage } = await this.chat.sendMessage(user, conversationId, { text, clientRequestId: `skill-run:${run.id}` }, { skillRunId: run.id });

      if (assistantMessage.status === MessageStatus.COMPLETED) {
        await this.notify(owner.telegramId, skill, assistantMessage);
      } else if (run.attempts < MAX_ATTEMPTS) {
        await this.prisma.skillRun.update({ where: { id: run.id }, data: { status: SkillRunStatus.QUEUED, lockedAt: null } });
      }
    } catch (err) {
      this.logger.error(`skill run ${run.id} failed (attempt ${run.attempts}): ${err instanceof Error ? err.message : String(err)}`);
      if (run.attempts >= MAX_ATTEMPTS) await this.fail(run.id, 'Не удалось выполнить навык');
      else await this.prisma.skillRun.update({ where: { id: run.id }, data: { status: SkillRunStatus.QUEUED, lockedAt: null } });
    }
  }

  private async openConversation(run: SkillRun, slug: string): Promise<string> {
    const conversation = await this.prisma.conversation.create({ data: { employeeId: run.ownerId, title: runTitle(slug, run.createdAt) } });
    await this.prisma.skillRun.update({ where: { id: run.id }, data: { conversationId: conversation.id } });
    return conversation.id;
  }

  private async fail(runId: string, error: string): Promise<void> {
    await this.prisma.skillRun.update({ where: { id: runId }, data: { status: SkillRunStatus.FAILED, error, lockedAt: null, finishedAt: new Date() } });
  }

  // TELEGRAM — сам ответ; остальное — короткое уведомление, что готово.
  private async notify(telegramId: string | null, skill: { slug: string; title: string; output: string }, message: MessageWithParts): Promise<void> {
    if (!this.telegram || !telegramId) return;
    const markdown = message.parts
      .filter((p) => p.type === MessagePartType.MARKDOWN)
      .map((p) => (p.data as { content?: unknown })?.content)
      .filter((c): c is string => typeof c === 'string')
      .join('\n\n');
    const text =
      skill.output === 'TELEGRAM'
        ? clipForTelegram(`${skill.title}\n\n${markdownToTelegramText(markdown)}`)
        : skill.output === 'DOCX'
          ? `Навык /${skill.slug}: документ «${skill.title}» готов — он в ассистенте Адъютанта.`
          : `Навык /${skill.slug} выполнен — ответ в ассистенте Адъютанта.`;
    await this.telegram.sendMessage(telegramId, text);
  }
}

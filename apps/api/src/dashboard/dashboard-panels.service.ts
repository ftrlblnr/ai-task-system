import { Injectable } from '@nestjs/common';
import {
  EmailFolderRole,
  FileArtifactSource,
  Prisma,
  RoutineState,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { localDateString, TIMEZONE_OFFSET_HOURS } from '../common/timezone';
import { MailStore } from '../mail/mail-store';
import { MailTriageService } from '../mail/triage/mail-triage.service';

// Пульт руководителя (ARMS, фаза 6): панели почты, регламентов, навыков,
// файлов и расхода — обычные запросы к БД, без вызова модели. Каждая панель
// — отдельная секция overview со своим status/fetchedAt.

const MAIL_TOP = 3;
const ROUTINES_LIMIT = 5;
const SKILLS_LIMIT = 6;
const FILES_LIMIT = 24;

const ok = () => ({
  status: 'ok' as const,
  fetchedAt: new Date().toISOString(),
});

// Полночь сегодняшнего дня по времени компании.
export function localDayStart(now: Date): Date {
  return new Date(
    new Date(`${localDateString(now)}T00:00:00.000Z`).getTime() -
      TIMEZONE_OFFSET_HOURS * 3_600_000,
  );
}

@Injectable()
export class DashboardPanelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
    private readonly mailStore: MailStore,
    private readonly triage: MailTriageService,
  ) {}

  // «Почта» (W5): ждут ответа и первые письма — из очереди «Разбора» того же
  // ящика, что открывается на /mail; за сутки и микс — по всем ящикам.
  async mail(employeeId: string) {
    const mailbox = await this.mailStore.findOwnedMailbox(employeeId);
    if (!mailbox)
      return {
        ...ok(),
        connected: false,
        received24h: 0,
        needsReply: 0,
        top: [],
        mix: [],
        lastSyncedAt: null,
      };
    const incoming: Prisma.EmailMessageWhereInput = {
      mailbox: { employeeId },
      isOutgoing: false,
      deletedAt: null,
      folder: { role: EmailFolderRole.INBOX },
    };
    const since24h = new Date(Date.now() - 86_400_000);
    const [received24h, triage, mix, synced] = await Promise.all([
      this.prisma.emailMessage.count({
        where: { ...incoming, receivedAt: { gte: since24h } },
      }),
      this.triage.summary(mailbox.id, MAIL_TOP),
      this.prisma.emailAnalysis.groupBy({
        by: ['category'],
        where: {
          emailMessage: { ...incoming, receivedAt: { gte: since24h } },
          category: { not: null },
        },
        _count: { _all: true },
      }),
      this.prisma.mailbox.aggregate({
        where: { employeeId },
        _max: { lastSyncedAt: true },
      }),
    ]);
    return {
      ...ok(),
      connected: true,
      received24h,
      needsReply: triage.needsReply,
      top: triage.top.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.fromName || m.fromAddress,
        receivedAt: m.receivedAt?.toISOString() ?? null,
        importance: m.importance,
        tag: m.tag,
      })),
      mix: mix
        .map((g) => ({ category: g.category as string, count: g._count._all }))
        .sort((a, b) => b.count - a.count),
      lastSyncedAt: synced._max.lastSyncedAt?.toISOString() ?? null,
    };
  }

  // Сегодняшние прогоны (свежие сверху) и ближайшие запуски.
  async routines(ownerId: string) {
    const [upcoming, today, activeCount] = await Promise.all([
      this.prisma.routine.findMany({
        where: {
          ownerId,
          state: RoutineState.ACTIVE,
          nextRunAt: { not: null },
        },
        orderBy: { nextRunAt: 'asc' },
        take: ROUTINES_LIMIT,
        select: { id: true, title: true, nextRunAt: true },
      }),
      this.prisma.routineRun.findMany({
        where: {
          routine: { ownerId },
          createdAt: { gte: localDayStart(new Date()) },
        },
        orderBy: { createdAt: 'desc' },
        take: ROUTINES_LIMIT,
        select: {
          id: true,
          status: true,
          createdAt: true,
          finishedAt: true,
          conversationId: true,
          routine: { select: { id: true, title: true } },
        },
      }),
      this.prisma.routine.count({
        where: { ownerId, state: RoutineState.ACTIVE },
      }),
    ]);
    return {
      ...ok(),
      activeCount,
      items: [
        ...today.map((r) => ({
          id: r.id,
          routineId: r.routine.id,
          title: r.routine.title,
          at: (r.finishedAt ?? r.createdAt).toISOString(),
          status: r.status,
          conversationId: r.conversationId,
        })),
        ...upcoming.map((r) => ({
          id: `next:${r.id}`,
          routineId: r.id,
          title: r.title,
          at: (r.nextRunAt as Date).toISOString(),
          status: 'NEXT',
          conversationId: null,
        })),
      ],
    };
  }

  // Колода навыков: самые используемые за 30 дней.
  async skills(ownerId: string) {
    const skills = await this.prisma.skill.findMany({
      where: { enabled: true, OR: [{ ownerId: null }, { ownerId }] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        kind: true,
        model: true,
        effort: true,
      },
    });
    const runs = await this.prisma.skillRun.groupBy({
      by: ['skillId'],
      where: {
        ownerId,
        createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
      },
      _count: { _all: true },
    });
    const count = new Map(runs.map((r) => [r.skillId, r._count._all]));
    const items = skills
      .map((s) => ({ ...s, runs30d: count.get(s.id) ?? 0 }))
      .sort((a, b) => b.runs30d - a.runs30d);
    return {
      ...ok(),
      total: skills.length,
      items: items.slice(0, SKILLS_LIMIT),
      all: skills.map((s) => ({ id: s.id, slug: s.slug, title: s.title })),
    };
  }

  // «Входящие файлы»: последние сгенерированные ассистентом.
  async files(employeeId: string) {
    const now = new Date();
    const where: Prisma.FileArtifactWhereInput = {
      employeeId,
      source: FileArtifactSource.GENERATED,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };
    const [items, total] = await Promise.all([
      this.prisma.fileArtifact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: FILES_LIMIT,
        select: {
          id: true,
          name: true,
          mimeType: true,
          size: true,
          createdAt: true,
          conversationId: true,
        },
      }),
      this.prisma.fileArtifact.count({ where }),
    ]);
    return {
      ...ok(),
      total,
      items: items.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })),
    };
  }

  async usage() {
    const [today, week] = await Promise.all([
      this.aiUsage.summary(1, 'feature'),
      this.aiUsage.summary(7, 'feature'),
    ]);
    const totals = (t: typeof today.total) => ({
      calls: t.calls,
      tokens:
        t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens,
      costUsd: t.costUsd,
      cacheShare: t.cacheShare,
    });
    return {
      ...ok(),
      today: totals(today.total),
      week: totals(week.total),
      daily: week.daily,
    };
  }
}

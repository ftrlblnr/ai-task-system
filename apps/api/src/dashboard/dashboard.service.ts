import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { ReceptionService } from '../reception/reception.service';
import { EventsService } from '../calendar/events.service';
import { isTaskOverdue } from '../tasks/tasks.service';

// «Стол руководителя» (владелец 05.10.2026, ТЗ v1.0) — раздел 13.2:
// рекомендованный агрегирующий контракт, три независимых раздела (tasks/
// reception/calendar), каждый сам решает ok/error — недоступность одного
// источника не должна скрывать два других (раздел 14 ТЗ).
const ATTENTION_TASKS_LIMIT = 5;
const RECEPTION_PREVIEW_LIMIT = 3;
const CALENDAR_PREVIEW_LIMIT = 3;
// Защитный потолок на выборку "активных" задач для сортировки/среза топ-5
// (раздел 16 ТЗ — счётчики проверяются на 1000+ задачах; сами счётчики идут
// отдельными COUNT-запросами ниже и этого потолка не касаются, он нужен
// только чтобы не тащить в память абсолютно все активные задачи, если их
// когда-нибудь станет аномально много).
const ATTENTION_CANDIDATES_CAP = 500;
const TIMEZONE = 'Asia/Almaty';

// Без `as const` — Prisma ожидает мутабельный TaskStatus[] в notIn, readonly
// tuple туда не присваивается (их же TaskWhereInput это требует).
const ACTIVE_STATUS: Prisma.TaskWhereInput = { status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] } };

export interface SectionError {
  status: 'error';
  fetchedAt: null;
  message: string;
}

function errorSection(err: unknown, logger: Logger, label: string): SectionError {
  logger.error(`dashboard overview: ${label} failed: ${err instanceof Error ? err.name : 'unknown'}`);
  return { status: 'error', fetchedAt: null, message: 'Данные недоступны' };
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reception: ReceptionService,
    private readonly events: EventsService,
  ) {}

  async getOverview(user: AuthenticatedUser) {
    const [tasks, reception, calendar] = await Promise.all([
      this.getTasksSection().catch((err: unknown) => errorSection(err, this.logger, 'tasks')),
      this.getReceptionSection().catch((err: unknown) => errorSection(err, this.logger, 'reception')),
      this.getCalendarSection(user.id).catch((err: unknown) => errorSection(err, this.logger, 'calendar')),
    ]);
    return { generatedAt: new Date().toISOString(), timezone: TIMEZONE, tasks, reception, calendar };
  }

  private async getTasksSection() {
    const activeWhere: Prisma.TaskWhereInput = { parentTaskId: null, ...ACTIVE_STATUS };
    const [active, overdue, inReview, candidates] = await Promise.all([
      this.prisma.task.count({ where: activeWhere }),
      this.prisma.task.count({ where: { ...activeWhere, dueDate: { lt: new Date() } } }),
      this.prisma.task.count({ where: { parentTaskId: null, status: TaskStatus.IN_REVIEW } }),
      this.prisma.task.findMany({
        where: activeWhere,
        select: {
          id: true,
          title: true,
          status: true,
          dueDate: true,
          assignee: { select: { id: true, fullName: true } },
        },
        take: ATTENTION_CANDIDATES_CAP,
      }),
    ]);

    // Раздел 8 ТЗ, порядок: просроченные → затем IN_REVIEW → затем срок по
    // возрастанию (без срока — в конец группы) → стабильный тай-брейк по id.
    // Это программный порядок — явно не подписывается как "рекомендация ИИ".
    const items = [...candidates]
      .sort((a, b) => {
        const aOverdue = isTaskOverdue(a);
        const bOverdue = isTaskOverdue(b);
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
        const aReview = a.status === TaskStatus.IN_REVIEW;
        const bReview = b.status === TaskStatus.IN_REVIEW;
        if (aReview !== bReview) return aReview ? -1 : 1;
        const aDue = a.dueDate ? a.dueDate.getTime() : Infinity;
        const bDue = b.dueDate ? b.dueDate.getTime() : Infinity;
        if (aDue !== bDue) return aDue - bDue;
        return a.id.localeCompare(b.id);
      })
      .slice(0, ATTENTION_TASKS_LIMIT)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dueDate: t.dueDate,
        isOverdue: isTaskOverdue(t),
        assignee: t.assignee,
      }));

    return {
      status: 'ok' as const,
      fetchedAt: new Date().toISOString(),
      counts: { active, overdue, inReview },
      items,
    };
  }

  private async getReceptionSection() {
    const view = await this.reception.getQueueView({}, RECEPTION_PREVIEW_LIMIT, 0);
    return {
      status: 'ok' as const,
      fetchedAt: new Date().toISOString(),
      waitingCount: view.totalWaiting,
      current: view.current,
      items: view.items,
    };
  }

  private async getCalendarSection(employeeId: string) {
    const items = await this.events.findUpcoming(employeeId, CALENDAR_PREVIEW_LIMIT);
    return { status: 'ok' as const, fetchedAt: new Date().toISOString(), items };
  }
}

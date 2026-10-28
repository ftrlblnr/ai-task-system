import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import { isManager } from '../auth/roles';
import { formatLocalDateTime } from '../common/timezone';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { CreateCommentDto } from './dto/create-comment.dto';

const TASK_LIST_SELECT = {
  id: true,
  title: true,
  status: true,
  assigneeId: true,
  creatorId: true,
  priority: true,
  dueDate: true,
  aiConfidence: true,
  createdAt: true,
  taskProfile: { select: { id: true, category: true, type: true } },
  // direction — для клиентского фильтра задач по направлению (владелец
  // 30.09.2026, kanban-board.tsx), тот же принцип, что assignee-фильтр:
  // без отдельного запроса, из уже загруженных задач.
  assignee: { select: { id: true, fullName: true, direction: { select: { id: true, title: true } } } },
  creator: { select: { id: true, fullName: true } },
  // Только статусы — достаточно посчитать subtaskCount/subtaskDoneCount
  // (см. toListItem), полный список полей отдаёт только TASK_DETAIL_SELECT.
  subtasks: { select: { status: true } },
  // Дизайн-система «Адъютант» (владелец 04.10.2026, implementation.md шаг 6)
  // — fromAgent в toListItem ниже: задача создана ассистентом, не угадывается
  // на фронте, а прямо выводится из наличия sourceExecutionId.
  sourceExecutionId: true,
  // Название встречи на карточке в колонке (implementation.md шаг 6) — только
  // title, не полный протокол (тот уже и был доступен исполнителю в детальной
  // карточке задачи без доступа к самой встрече, раздел 9 ТЗ).
  sourceMeeting: { select: { title: true } },
} as const;

const TASK_DETAIL_SELECT = {
  ...TASK_LIST_SELECT,
  description: true,
  // Раздел 9 ТЗ: краткий контекст происхождения задачи виден исполнителю
  // без доступа к самой встрече — sourceMeeting отдаёт только title+дату
  // (не транскрипт/саммари), сам протокол доступен только через
  // MeetingsController, который закрыт на OWNER (раздел 5 ТЗ).
  sourceMeeting: { select: { id: true, title: true, meetingDate: true } },
  sourceTimestamp: true,
  sourceContext: true,
  // Подзадачи (владелец 08.09.2026, один уровень вложенности — см.
  // create()) — здесь переопределяем короткий select из TASK_LIST_SELECT
  // полным набором полей для чек-листа на карточке. parentTask — обратная
  // ссылка, если сама эта задача — подзадача (хлебная крошка на фронте).
  parentTask: { select: { id: true, title: true } },
  subtasks: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      dueDate: true,
      assignee: { select: { id: true, fullName: true } },
    },
  },
  // Наблюдатели (владелец 08.09.2026, модель «один ответственный +
  // наблюдатели», не множественное назначение — см. TaskWatcher в схеме).
  watchers: {
    select: { employee: { select: { id: true, fullName: true } } },
  },
  comments: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      body: true,
      createdAt: true,
      author: { select: { id: true, fullName: true } },
    },
  },
  history: {
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
      field: true,
      oldValue: true,
      newValue: true,
      createdAt: true,
      changedBy: { select: { id: true, fullName: true } },
    },
  },
} as const;

// Подчинённому, который меняет статус сам себе, доступны только рабочие
// переходы — возврат на доработку/отмена остаются решением руководителя
// (раздел 10 ТЗ: значимые решения не отдаются в автономию).
// export — тестируется напрямую в tasks.service.spec.ts (аудит 10.09.2026,
// п. 5.1: граница доступа, значимая для RBAC, должна быть под тестом).
export const EMPLOYEE_ALLOWED_STATUSES: TaskStatus[] = [
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.DONE,
];

// Русские подписи статусов для текста push-уведомлений — та же информация,
// что в apps/web/src/lib/labels.ts и apps/miniapp/src/lib/labels.ts
// (STATUS_LABELS), но бэкенду не нужен весь набор, только текст сообщения;
// эти два файла и так дублируют друг друга по комментарию в miniapp/labels.ts,
// третья копия здесь — тот же осознанный компромисс. Экспортируется — тем же
// текстом пользуется tasks-overdue.cron.ts.
export const TASK_STATUS_RU: Record<TaskStatus, string> = {
  DRAFT: 'Черновик',
  NEW: 'Новая',
  IN_PROGRESS: 'В работе',
  IN_REVIEW: 'На проверке',
  DONE: 'Выполнена',
  RETURNED: 'Возвращена на доработку',
  CANCELLED: 'Отменена',
};

// Просрочка — вычисляемый признак, не статус (аудит 10.09.2026, п. 2.1):
// раньше отдельный TaskStatus.OVERDUE выставлял крон каждые 30 минут и тем
// самым перетирал статус, который сотрудник только что сам сменил на
// IN_PROGRESS. Используется в toListItem/findOne ниже — то же условие
// (dueDate в прошлом, status не DONE/CANCELLED) TasksOverdueCron выражает
// отдельно как Prisma where-фильтр (вызвать JS-функцию внутри SQL-запроса
// нельзя), но по смыслу это одно и то же правило.
export function isTaskOverdue(task: { dueDate: Date | null; status: TaskStatus }): boolean {
  if (!task.dueDate) return false;
  if (task.status === TaskStatus.DONE || task.status === TaskStatus.CANCELLED) return false;
  return task.dueDate < new Date();
}

// Не чаще раза в час на задачу — см. TasksService.remind.
export const REMIND_INTERVAL_MS = 60 * 60 * 1000;

// Поиск задач для агента (единый агент A1, docs/AGENT_AND_MEETINGS.md):
// ассистент раньше видел только первые 10 из findAll() с фильтром
// all/overdue и не мог честно ответить «что у Ирины просрочено» при 60
// задачах. Фильтры и счётчики — запросами в БД, не перебором findAll().
export const CLOSED_TASK_STATUSES: TaskStatus[] = [TaskStatus.DONE, TaskStatus.CANCELLED];
export const TASK_SEARCH_MAX_LIMIT = 30;

export interface TaskSearchFilter {
  // null — задачи без исполнителя; undefined — не фильтровать.
  assigneeId?: string | null;
  creatorId?: string;
  // Пусто/не задано — открытые (всё, кроме выполненных и отменённых).
  statuses?: TaskStatus[];
  overdue?: boolean;
  dueFrom?: Date;
  dueTo?: Date;
  query?: string;
  sourceMeetingId?: string;
  limit: number;
}

export interface TaskSearchGroup {
  assigneeId: string | null;
  name: string;
  count: number;
  overdue: number;
}

// Чистая функция — тестируется без БД. Подзадачи не ищутся, как и в общем
// списке (они живут внутри карточки родителя).
export function buildTaskSearchWhere(filter: TaskSearchFilter, now: Date = new Date()): Prisma.TaskWhereInput {
  const and: Prisma.TaskWhereInput[] = [{ parentTaskId: null }];
  and.push(filter.statuses && filter.statuses.length > 0 ? { status: { in: filter.statuses } } : { status: { notIn: CLOSED_TASK_STATUSES } });
  if (filter.assigneeId !== undefined) and.push({ assigneeId: filter.assigneeId });
  if (filter.creatorId) and.push({ creatorId: filter.creatorId });
  if (filter.overdue) and.push(overdueWhere(now));
  if (filter.dueFrom || filter.dueTo) and.push({ dueDate: { ...(filter.dueFrom ? { gte: filter.dueFrom } : {}), ...(filter.dueTo ? { lte: filter.dueTo } : {}) } });
  const query = filter.query?.trim();
  if (query) {
    and.push({ OR: [{ title: { contains: query, mode: 'insensitive' } }, { description: { contains: query, mode: 'insensitive' } }] });
  }
  if (filter.sourceMeetingId) and.push({ sourceMeetingId: filter.sourceMeetingId });
  return { AND: and };
}

// То же правило, что isTaskOverdue, в виде Prisma-фильтра.
function overdueWhere(now: Date): Prisma.TaskWhereInput {
  return { dueDate: { lt: now }, status: { notIn: CLOSED_TASK_STATUSES } };
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
  ) {}

  // Владелец 20.10.2026: все видят все задачи (контроль исполнения
  // поручений открыт всем). parentTaskId: null — подзадачи не попадают в общий список/канбан
  // независимо от роли, только внутри карточки родителя (владелец 08.09.2026,
  // по образцу Linear/Asana — не захламлять основную доску).
  // Бейдж «Задачи» в меню и плитка «просрочено» на пульте (W5) — то же, что
  // фильтр «Просрочено»: открытые задачи верхнего уровня со сроком в прошлом.
  overdueCount(): Promise<number> {
    return this.prisma.task.count({
      where: { parentTaskId: null, status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] }, dueDate: { lt: new Date() } },
    });
  }

  async findAll() {
    const tasks = await this.prisma.task.findMany({
      where: {
        parentTaskId: null,
      },
      select: TASK_LIST_SELECT,
      // order asc — ручная перестановка внутри колонки (владелец 08.09.2026),
      // createdAt desc — тай-брейк: у всех, кого никогда не перетаскивали,
      // order одинаковый (default 0), поэтому список ведёт себя как раньше
      // ("новые сверху"), пока пользователь не переставит что-то вручную.
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
    });
    return tasks.map((t) => this.toListItem(t));
  }

  // Поиск для агента: срез по сроку (ближайшие и просроченные сверху, без
  // срока — в конце) и счётчики по ВСЕЙ выборке, не по срезу — модель
  // говорит «всего 37, у Ирины 5 просрочено», а не «вижу 10».
  async search(filter: TaskSearchFilter) {
    const now = new Date();
    const where = buildTaskSearchWhere(filter, now);
    const overdue: Prisma.TaskWhereInput = { AND: [where, overdueWhere(now)] };
    const limit = Math.min(Math.max(1, filter.limit), TASK_SEARCH_MAX_LIMIT);
    const [rows, totalCount, overdueCount, byAssigneeRaw, overdueByAssigneeRaw, byStatusRaw] = await Promise.all([
      this.prisma.task.findMany({
        where,
        select: TASK_LIST_SELECT,
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: limit,
      }),
      this.prisma.task.count({ where }),
      this.prisma.task.count({ where: overdue }),
      this.prisma.task.groupBy({ by: ['assigneeId'], where, _count: { _all: true } }),
      this.prisma.task.groupBy({ by: ['assigneeId'], where: overdue, _count: { _all: true } }),
      this.prisma.task.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);

    const assigneeIds = byAssigneeRaw.map((g) => g.assigneeId).filter((id): id is string => id !== null);
    const names = assigneeIds.length
      ? new Map((await this.prisma.employee.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, fullName: true } })).map((e) => [e.id, e.fullName]))
      : new Map<string, string>();
    const overdueBy = new Map(overdueByAssigneeRaw.map((g) => [g.assigneeId, g._count._all]));
    const byAssignee: TaskSearchGroup[] = byAssigneeRaw
      .map((g) => ({
        assigneeId: g.assigneeId,
        name: g.assigneeId ? (names.get(g.assigneeId) ?? 'Неизвестный сотрудник') : 'Без исполнителя',
        count: g._count._all,
        overdue: overdueBy.get(g.assigneeId) ?? 0,
      }))
      .sort((a, b) => b.overdue - a.overdue || b.count - a.count || a.name.localeCompare(b.name, 'ru'));
    const byStatus = byStatusRaw.map((g) => ({ status: g.status, count: g._count._all })).sort((a, b) => b.count - a.count);

    return { items: rows.map((t) => this.toListItem(t)), totalCount, overdueCount, byAssignee, byStatus };
  }

  // Полная новая последовательность одной колонки канбана (все задачи
  // этого статуса, в новом порядке) — владелец 08.09.2026: "задачи можно
  // было переставлять вверх-вниз в столбце". Порядок общий для всех, а
  // видят задачи теперь все (владелец 20.10.2026) — поэтому пользователь
  // переставляет только свои (поставленные им или ему), руководство — любые.
  async reorder(taskIds: string[], actor: AuthenticatedUser) {
    const tasks = await this.prisma.task.findMany({ where: { id: { in: taskIds } } });
    if (tasks.length !== taskIds.length) {
      throw new NotFoundException('Одна или несколько задач не найдены');
    }
    if (!isManager(actor.role) && tasks.some((t) => t.creatorId !== actor.id && t.assigneeId !== actor.id)) {
      throw new ForbiddenException('Переставлять можно только свои задачи');
    }

    await this.prisma.$transaction(
      taskIds.map((id, index) => this.prisma.task.update({ where: { id }, data: { order: index } })),
    );
  }

  async findOne(id: string) {
    const task = await this.prisma.task.findUnique({ where: { id }, select: TASK_DETAIL_SELECT });
    if (!task) throw new NotFoundException('Задача не найдена');

    // Раньше здесь писался AuditLog READ на каждое открытие карточки —
    // аудит 10.09.2026, п. 2.13: обычная задача не «чувствительный контент»
    // в смысле раздела 15 ТЗ (это встречи — протокол/саммари реального
    // разговора), а таблица аудита росла быстрее всех остальных без какой-
    // либо ретенции ради этого шума. AuditService/MeetingsService.findOne
    // по-прежнему логируют READ там, где это оправдано.

    // sourceExecutionId убран из rest — TASK_LIST_SELECT (через который
    // проходит TASK_DETAIL_SELECT) теперь выбирает его для toListItem/
    // fromAgent, но сырой внутренний id исполнения ассистента в детальный
    // ответ наружу не нужен (в списке он тоже не выводится — только
    // производное fromAgent, см. toListItem). fromAgent/source — как в
    // списке: TaskDetail расширяет TaskListItem (боковая карточка W3).
    const { subtasks, watchers, sourceExecutionId, ...rest } = task;
    return {
      ...rest,
      fromAgent: sourceExecutionId != null,
      source: rest.sourceMeeting?.title ?? null,
      subtasks,
      subtaskCount: subtasks.length,
      subtaskDoneCount: subtasks.filter((s) => s.status === TaskStatus.DONE).length,
      watchers: watchers.map((w) => w.employee),
      isOverdue: isTaskOverdue(task),
    };
  }

  async create(dto: CreateTaskDto, creator: AuthenticatedUser) {
    // Задачи из Plaud-встречи ставит только руководитель (владелец,
    // 28.08.2026) — сотрудник и так не видит /meetings, но проверяем и
    // здесь: source-поля не должны просачиваться в обход UI. Расширено на
    // весь набор source-полей (hardening-раунд Phase O, 22.09.2026, P1) —
    // раньше проверялся только sourceMeetingId, а sourceSegmentId/
    // sourceExecutionId можно было теоретически передать отдельно от него.
    if ((dto.sourceMeetingId || dto.sourceSegmentId || dto.sourceExecutionId) && !isManager(creator.role)) {
      throw new ForbiddenException('Задачи из встречи может ставить только руководитель');
    }

    // Hardening-раунд Phase O (22.09.2026, P1 "source integrity") —
    // раньше эти инварианты проверял только create_task_from_meeting
    // (caller), не сам domain service: другой/будущий caller, не
    // повторивший ту же проверку, мог передать sourceSegmentId без
    // sourceMeetingId, либо sourceSegmentId из СОВСЕМ ДРУГОЙ встречи.
    // create_task_from_meeting по-прежнему делает свою раннюю проверку
    // (с конкретным дружелюбным кодом SEGMENT_MISMATCH до вызова этого
    // метода) — эта проверка здесь ей не замена, а последний рубеж для
    // любого другого пути создания задачи.
    if (dto.sourceSegmentId) {
      if (!dto.sourceMeetingId) {
        throw new BadRequestException('sourceSegmentId указан без sourceMeetingId');
      }
      const segment = await this.prisma.meetingSegment.findUnique({ where: { id: dto.sourceSegmentId }, select: { meetingId: true } });
      if (!segment || segment.meetingId !== dto.sourceMeetingId) {
        throw new BadRequestException('sourceSegmentId не принадлежит указанной встрече');
      }
    }

    // Подзадачи — один уровень вложенности (как в Jira/Asana): у подзадачи
    // не может быть своих подзадач. Родитель должен быть виден создающему —
    // та же граница видимости, что и для самой задачи.
    if (dto.parentTaskId) {
      const parent = await this.getOrThrow(dto.parentTaskId);
      if (parent.parentTaskId) {
        throw new BadRequestException('У подзадачи не может быть своих подзадач');
      }
    }

    const task = await this.prisma.task.create({
      data: {
        title: dto.title,
        description: dto.description,
        taskProfileId: dto.taskProfileId,
        assigneeId: dto.assigneeId,
        parentTaskId: dto.parentTaskId,
        priority: dto.priority,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        sourceMeetingId: dto.sourceMeetingId,
        sourceTimestamp: dto.sourceTimestamp,
        sourceContext: dto.sourceContext,
        sourceSegmentId: dto.sourceSegmentId,
        sourceExecutionId: dto.sourceExecutionId,
        aiConfidence: dto.aiConfidence,
        creatorId: creator.id,
        // Задачи из саммари встречи (владелец 09.09.2026) тоже идут через
        // этот метод — но только после того, как руководитель отредактировал
        // и подтвердил черновик в модалке (см. MeetingsService.createTasksFromMeeting).
        // До подтверждения черновики эфемерны, в БД не попадают — поэтому
        // «Черновик»-статус (DRAFT) здесь не нужен, подтверждение уже
        // произошло самим фактом вызова этого метода.
        status: TaskStatus.NEW,
      },
      select: TASK_LIST_SELECT,
    });

    if (task.assigneeId && task.assigneeId !== creator.id) {
      const due = task.dueDate ? ` (срок: ${task.dueDate.toLocaleDateString('ru-RU')})` : '';
      this.notifyEmployee(task.assigneeId, `Вам назначена задача: «${task.title}»${due}`);
    }

    return this.toListItem(task);
  }

  // Общее редактирование (переназначение, срок, приоритет) — руководитель
  // или сам постановщик задачи (раздел 5 ТЗ, скорректировано 28.08.2026:
  // ставить и вести задачу может любой участник, не только руководитель).
  async update(id: string, dto: UpdateTaskDto, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(id);
    if (!isManager(actor.role) && task.creatorId !== actor.id) {
      throw new ForbiddenException('Редактировать задачу может только её постановщик или руководитель');
    }

    const changes = this.diff(task, dto);
    await this.prisma.$transaction([
      this.prisma.task.update({
        where: { id },
        data: {
          title: dto.title,
          description: dto.description,
          taskProfileId: dto.taskProfileId,
          assigneeId: dto.assigneeId,
          priority: dto.priority,
          // dto.dueDate === undefined — поле не пришло в запросе, не трогаем;
          // null — явно снять срок; строка — новая дата. Раньше null тоже
          // превращался в undefined и снять срок через редактирование было
          // невозможно (владелец 08.09.2026: "задачи нельзя редактировать").
          dueDate: dto.dueDate === undefined ? undefined : dto.dueDate ? new Date(dto.dueDate) : null,
          // Срок поменялся — сбрасываем отметку об уведомлении о просрочке
          // (аудит 10.09.2026, п. 2.1), иначе TasksOverdueCron решит, что уже
          // уведомлял, и не пришлёт уведомление заново, если новый срок тоже
          // окажется в прошлом или задача снова станет просроченной позже.
          overdueNotifiedAt: dto.dueDate === undefined ? undefined : null,
        },
      }),
      ...changes.map((change) =>
        this.prisma.taskHistory.create({
          data: { taskId: id, changedById: actor.id, ...change },
        }),
      ),
    ]);

    // Переназначение — уведомляем нового исполнителя, если это не сам актор.
    if (dto.assigneeId !== undefined && dto.assigneeId !== task.assigneeId && dto.assigneeId !== actor.id) {
      this.notifyEmployee(dto.assigneeId, `Вам назначена задача: «${dto.title ?? task.title}»`);
    }

    return this.findOne(id);
  }

  async updateStatus(id: string, status: TaskStatus, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(id);

    // Видеть задачу теперь может и её постановщик, не только исполнитель —
    // но менять статус по-прежнему может только тот, кто её выполняет
    // (или руководитель). Иначе постановщик мог бы сам отчитаться о
    // выполнении чужой работы.
    if (!isManager(actor.role) && task.assigneeId !== actor.id) {
      throw new ForbiddenException('Статус может менять исполнитель задачи или руководитель');
    }
    if (!isManager(actor.role) && !EMPLOYEE_ALLOWED_STATUSES.includes(status)) {
      throw new ForbiddenException('Этот статус может установить только руководитель');
    }

    await this.prisma.$transaction([
      this.prisma.task.update({ where: { id }, data: { status } }),
      this.prisma.taskHistory.create({
        data: {
          taskId: id,
          changedById: actor.id,
          field: 'status',
          oldValue: task.status,
          newValue: status,
        },
      }),
    ]);

    const text = `Задача «${task.title}»: статус изменён на «${TASK_STATUS_RU[status]}»`;
    if (task.creatorId !== actor.id) this.notifyEmployee(task.creatorId, text);
    void this.notifyWatchers(id, actor.id, text);

    return this.findOne(id);
  }

  // «Напомнить исполнителю» (редизайн web W3, docs/WEB_REDESIGN.md §4.4) —
  // одно сообщение в Telegram исполнителю. Может постановщик или
  // руководство; не чаще раза в час на задачу (отметка — строка истории
  // field 'remind', она же видна в карточке). В отличие от прочих
  // уведомлений отправка синхронная: пользователь нажал кнопку и должен
  // знать, дошло ли напоминание.
  async remind(id: string, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(id);
    if (!isManager(actor.role) && task.creatorId !== actor.id) {
      throw new ForbiddenException('Напомнить может постановщик задачи или руководитель');
    }
    if (!task.assigneeId) throw new BadRequestException('У задачи нет исполнителя');
    if (task.assigneeId === actor.id) throw new BadRequestException('Это ваша задача');
    if (task.status === TaskStatus.DONE || task.status === TaskStatus.CANCELLED) {
      throw new BadRequestException('Задача уже закрыта');
    }

    const last = await this.prisma.taskHistory.findFirst({
      where: { taskId: id, field: 'remind', createdAt: { gt: new Date(Date.now() - REMIND_INTERVAL_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (last) {
      throw new HttpException('Напоминание уже отправлено в течение последнего часа', HttpStatus.TOO_MANY_REQUESTS);
    }

    const [assignee, author] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: task.assigneeId }, select: { telegramId: true } }),
      this.prisma.employee.findUnique({ where: { id: actor.id }, select: { fullName: true } }),
    ]);
    if (!assignee?.telegramId) throw new BadRequestException('У исполнителя не привязан Telegram');

    const due = task.dueDate ? `, срок — ${formatLocalDateTime(task.dueDate)}` : '';
    const from = author?.fullName ? `${author.fullName} напоминает` : 'Напоминание';
    const sent = await this.bot.sendMessageWithResult(assignee.telegramId, `${from} о задаче «${task.title}»${due}`);
    if (!sent.ok) throw new ServiceUnavailableException('Не удалось отправить напоминание в Telegram');

    await this.prisma.taskHistory.create({
      data: { taskId: id, changedById: actor.id, field: 'remind', newValue: task.assigneeId },
    });
    return this.findOne(id);
  }

  async addComment(id: string, dto: CreateCommentDto, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(id);

    await this.prisma.taskComment.create({
      data: { taskId: id, authorId: actor.id, body: dto.body },
    });

    const text = `Новый комментарий к задаче «${task.title}»`;
    const otherPartyId = actor.id === task.creatorId ? task.assigneeId : task.creatorId;
    if (otherPartyId && otherPartyId !== actor.id) this.notifyEmployee(otherPartyId, text);
    void this.notifyWatchers(id, actor.id, text);

    return this.findOne(id);
  }

  // Наблюдатель (владелец 08.09.2026): любой участник может подписаться
  // сам на себя; добавить наблюдателем ДРУГОГО человека может только
  // руководитель — как и остальные значимые назначения в системе.
  async addWatcher(taskId: string, employeeId: string | undefined, actor: AuthenticatedUser) {
    await this.getOrThrow(taskId);
    const targetId = employeeId ?? actor.id;
    if (targetId !== actor.id && !isManager(actor.role)) {
      throw new ForbiddenException('Добавить наблюдателем другого человека может только руководитель');
    }
    await this.prisma.taskWatcher.upsert({
      where: { taskId_employeeId: { taskId, employeeId: targetId } },
      create: { taskId, employeeId: targetId },
      update: {},
    });
    return this.findOne(taskId);
  }

  async removeWatcher(taskId: string, employeeId: string, actor: AuthenticatedUser) {
    await this.getOrThrow(taskId);
    if (employeeId !== actor.id && !isManager(actor.role)) {
      throw new ForbiddenException('Убрать другого наблюдателя может только руководитель');
    }
    await this.prisma.taskWatcher.deleteMany({ where: { taskId, employeeId } });
    return this.findOne(taskId);
  }

  // Удалить может руководитель или сам постановщик задачи — та же граница,
  // что у update() (раздел 5 ТЗ: постановщик ведёт задачу целиком, включая
  // право её убрать). TaskComment/TaskAttachment/TaskHistory удаляются
  // каскадом на уровне схемы (onDelete: Cascade) — отдельно чистить не нужно.
  async remove(id: string, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(id);
    if (!isManager(actor.role) && task.creatorId !== actor.id) {
      throw new ForbiddenException('Удалить задачу может только её постановщик или руководитель');
    }
    await this.prisma.task.delete({ where: { id } });
  }

  private async getOrThrow(id: string) {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Задача не найдена');
    return task;
  }

  // Аудит 10.09.2026, п. 2.3: комментарий у модели TaskHistory обещает
  // "статус, исполнитель, срок", но реально отслеживались только title/
  // assigneeId/priority — перенос срока (то, что руководитель проверяет в
  // первую очередь) в историю не попадал вообще. Добавлены dueDate/
  // description/taskProfileId.
  private diff(
    task: {
      title: string;
      assigneeId: string | null;
      priority: string;
      status: string;
      dueDate: Date | null;
      description: string | null;
      taskProfileId: string | null;
    },
    dto: UpdateTaskDto,
  ) {
    const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];
    if (dto.title !== undefined && dto.title !== task.title) {
      changes.push({ field: 'title', oldValue: task.title, newValue: dto.title });
    }
    if (dto.assigneeId !== undefined && dto.assigneeId !== task.assigneeId) {
      changes.push({ field: 'assigneeId', oldValue: task.assigneeId, newValue: dto.assigneeId });
    }
    if (dto.priority !== undefined && dto.priority !== task.priority) {
      changes.push({ field: 'priority', oldValue: task.priority, newValue: dto.priority });
    }
    // dueDate === undefined — не пришло в запросе, не трогаем; null — явно
    // снят срок; строка — новый. Сравниваем по ISO-строке, а не Date-объекту
    // (task.dueDate — Date, dto.dueDate — строка из тела запроса).
    if (dto.dueDate !== undefined) {
      const oldIso = task.dueDate ? task.dueDate.toISOString() : null;
      const newIso = dto.dueDate ? new Date(dto.dueDate).toISOString() : null;
      if (oldIso !== newIso) changes.push({ field: 'dueDate', oldValue: oldIso, newValue: newIso });
    }
    if (dto.description !== undefined && dto.description !== task.description) {
      changes.push({ field: 'description', oldValue: task.description, newValue: dto.description });
    }
    if (dto.taskProfileId !== undefined && dto.taskProfileId !== task.taskProfileId) {
      changes.push({ field: 'taskProfileId', oldValue: task.taskProfileId, newValue: dto.taskProfileId });
    }
    return changes;
  }

  // Схлопывает сырой subtasks: {status}[] из TASK_LIST_SELECT в два числа —
  // список задач не должен раздувать JSON полным содержимым каждой
  // подзадачи, детали видны только на странице самой задачи (findOne).
  private toListItem<
    T extends {
      subtasks: { status: TaskStatus }[];
      dueDate: Date | null;
      status: TaskStatus;
      sourceExecutionId: string | null;
      sourceMeeting: { title: string } | null;
    },
  >(task: T) {
    const { subtasks, sourceExecutionId, sourceMeeting, ...rest } = task;
    return {
      ...rest,
      subtaskCount: subtasks.length,
      subtaskDoneCount: subtasks.filter((s) => s.status === TaskStatus.DONE).length,
      isOverdue: isTaskOverdue(task),
      fromAgent: sourceExecutionId != null,
      source: sourceMeeting?.title ?? null,
    };
  }

  // Best-effort, не блокирует основную операцию — тот же принцип, что у
  // AuditService.log и GoogleCalendarSyncService.pushBestEffort. Не await'ится
  // вызывающим кодом нигде специально (fire-and-forget), чтобы push в
  // Telegram не добавлял задержку в ответ API.
  private notifyEmployee(employeeId: string | null | undefined, text: string): void {
    if (!employeeId) return;
    void this.prisma.employee
      .findUnique({ where: { id: employeeId }, select: { telegramId: true } })
      .then((emp) => this.bot.sendMessage(emp?.telegramId, text));
  }

  private async notifyWatchers(taskId: string, excludeActorId: string, text: string): Promise<void> {
    const watchers = await this.prisma.taskWatcher.findMany({
      where: { taskId, employeeId: { not: excludeActorId } },
      select: { employee: { select: { telegramId: true } } },
    });
    for (const w of watchers) void this.bot.sendMessage(w.employee.telegramId, text);
  }
}

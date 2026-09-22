import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role, TaskStatus } from '@prisma/client';
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
  assignee: { select: { id: true, fullName: true } },
  creator: { select: { id: true, fullName: true } },
  // Только статусы — достаточно посчитать subtaskCount/subtaskDoneCount
  // (см. toListItem), полный список полей отдаёт только TASK_DETAIL_SELECT.
  subtasks: { select: { status: true } },
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

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
  ) {}

  // Раздел 5 ТЗ (скорректировано 28.08.2026): руководитель видит все задачи;
  // подчинённый — свои по исполнению И те, что сам поставил другим —
  // иначе поставленная им задача пропадала бы из виду сразу после создания.
  // parentTaskId: null — подзадачи не попадают в общий список/канбан
  // независимо от роли, только внутри карточки родителя (владелец 08.09.2026,
  // по образцу Linear/Asana — не захламлять основную доску).
  async findAll(user: AuthenticatedUser) {
    const tasks = await this.prisma.task.findMany({
      where: {
        parentTaskId: null,
        ...(user.role === Role.OWNER ? {} : { OR: [{ assigneeId: user.id }, { creatorId: user.id }] }),
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

  // Полная новая последовательность одной колонки канбана (все задачи
  // этого статуса, в новом порядке) — владелец 08.09.2026: "задачи можно
  // было переставлять вверх-вниз в столбце". Не меняет статус/исполнителя
  // и потому не требует более строгой проверки, чем видимость задачи —
  // сотрудник может переставлять любые задачи, которые ему и так видны.
  async reorder(taskIds: string[], actor: AuthenticatedUser) {
    const tasks = await this.prisma.task.findMany({ where: { id: { in: taskIds } } });
    if (tasks.length !== taskIds.length) {
      throw new NotFoundException('Одна или несколько задач не найдены');
    }
    for (const task of tasks) this.assertVisible(task, actor);

    await this.prisma.$transaction(
      taskIds.map((id, index) => this.prisma.task.update({ where: { id }, data: { order: index } })),
    );
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const task = await this.prisma.task.findUnique({ where: { id }, select: TASK_DETAIL_SELECT });
    if (!task) throw new NotFoundException('Задача не найдена');
    this.assertVisible(task, user);

    // Раньше здесь писался AuditLog READ на каждое открытие карточки —
    // аудит 10.09.2026, п. 2.13: обычная задача не «чувствительный контент»
    // в смысле раздела 15 ТЗ (это встречи — протокол/саммари реального
    // разговора), а таблица аудита росла быстрее всех остальных без какой-
    // либо ретенции ради этого шума. AuditService/MeetingsService.findOne
    // по-прежнему логируют READ там, где это оправдано.

    const { subtasks, watchers, ...rest } = task;
    return {
      ...rest,
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
    // здесь: sourceMeetingId не должен просачиваться в обход UI.
    if (dto.sourceMeetingId && creator.role !== Role.OWNER) {
      throw new ForbiddenException('Задачи из встречи может ставить только руководитель');
    }

    // Подзадачи — один уровень вложенности (как в Jira/Asana): у подзадачи
    // не может быть своих подзадач. Родитель должен быть виден создающему —
    // та же граница видимости, что и для самой задачи.
    if (dto.parentTaskId) {
      const parent = await this.getOrThrow(dto.parentTaskId);
      this.assertVisible(parent, creator);
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
    if (actor.role !== Role.OWNER && task.creatorId !== actor.id) {
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

    return this.findOne(id, actor);
  }

  async updateStatus(id: string, status: TaskStatus, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(id);
    this.assertVisible(task, actor);

    // Видеть задачу теперь может и её постановщик, не только исполнитель —
    // но менять статус по-прежнему может только тот, кто её выполняет
    // (или руководитель). Иначе постановщик мог бы сам отчитаться о
    // выполнении чужой работы.
    if (actor.role !== Role.OWNER && task.assigneeId !== actor.id) {
      throw new ForbiddenException('Статус может менять исполнитель задачи или руководитель');
    }
    if (actor.role !== Role.OWNER && !EMPLOYEE_ALLOWED_STATUSES.includes(status)) {
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

    return this.findOne(id, actor);
  }

  async addComment(id: string, dto: CreateCommentDto, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(id);
    this.assertVisible(task, actor);

    await this.prisma.taskComment.create({
      data: { taskId: id, authorId: actor.id, body: dto.body },
    });

    const text = `Новый комментарий к задаче «${task.title}»`;
    const otherPartyId = actor.id === task.creatorId ? task.assigneeId : task.creatorId;
    if (otherPartyId && otherPartyId !== actor.id) this.notifyEmployee(otherPartyId, text);
    void this.notifyWatchers(id, actor.id, text);

    return this.findOne(id, actor);
  }

  // Наблюдатель (владелец 08.09.2026): любой участник может подписаться
  // сам на себя; добавить наблюдателем ДРУГОГО человека может только
  // руководитель — как и остальные значимые назначения в системе.
  async addWatcher(taskId: string, employeeId: string | undefined, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(taskId);
    this.assertVisible(task, actor);
    const targetId = employeeId ?? actor.id;
    if (targetId !== actor.id && actor.role !== Role.OWNER) {
      throw new ForbiddenException('Добавить наблюдателем другого человека может только руководитель');
    }
    await this.prisma.taskWatcher.upsert({
      where: { taskId_employeeId: { taskId, employeeId: targetId } },
      create: { taskId, employeeId: targetId },
      update: {},
    });
    return this.findOne(taskId, actor);
  }

  async removeWatcher(taskId: string, employeeId: string, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(taskId);
    this.assertVisible(task, actor);
    if (employeeId !== actor.id && actor.role !== Role.OWNER) {
      throw new ForbiddenException('Убрать другого наблюдателя может только руководитель');
    }
    await this.prisma.taskWatcher.deleteMany({ where: { taskId, employeeId } });
    return this.findOne(taskId, actor);
  }

  // Удалить может руководитель или сам постановщик задачи — та же граница,
  // что у update() (раздел 5 ТЗ: постановщик ведёт задачу целиком, включая
  // право её убрать). TaskComment/TaskAttachment/TaskHistory удаляются
  // каскадом на уровне схемы (onDelete: Cascade) — отдельно чистить не нужно.
  async remove(id: string, actor: AuthenticatedUser) {
    const task = await this.getOrThrow(id);
    if (actor.role !== Role.OWNER && task.creatorId !== actor.id) {
      throw new ForbiddenException('Удалить задачу может только её постановщик или руководитель');
    }
    await this.prisma.task.delete({ where: { id } });
  }

  // Видит задачу: руководитель, исполнитель или тот, кто её поставил
  // (раздел 5 ТЗ, скорректировано 28.08.2026).
  private assertVisible(task: { assigneeId: string | null; creatorId: string }, user: AuthenticatedUser) {
    if (user.role === Role.OWNER) return;
    if (task.assigneeId === user.id || task.creatorId === user.id) return;
    throw new ForbiddenException('Нет доступа к этой задаче');
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
  private toListItem<T extends { subtasks: { status: TaskStatus }[]; dueDate: Date | null; status: TaskStatus }>(
    task: T,
  ) {
    const { subtasks, ...rest } = task;
    return {
      ...rest,
      subtaskCount: subtasks.length,
      subtaskDoneCount: subtasks.filter((s) => s.status === TaskStatus.DONE).length,
      isOverdue: isTaskOverdue(task),
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

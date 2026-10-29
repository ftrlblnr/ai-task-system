import type Anthropic from '@anthropic-ai/sdk';
import { TaskStatus } from '@prisma/client';
import { TIMEZONE_OFFSET_HOURS, withLocalOffset } from '../common/timezone';
import type { TaskSearchGroup } from '../tasks/tasks.service';
import type { TaskCardData } from './dto/message-part-data.dto';

// Единый агент, этап A1 (docs/AGENT_AND_MEETINGS.md): поиск задач с
// фильтрами и одна задача целиком. Здесь только чистые вещи — схемы
// инструментов, разбор входа модели и форматирование ответа (тестируются
// без БД и ключа); исполнитель — AssistantToolsService.

export const FIND_TASKS_DEFAULT_LIMIT = 15;
// Сколько истории и комментариев задачи отдавать модели — хватает на «почему
// просрочено», не раздувает контекст.
export const TASK_DETAIL_HISTORY_LIMIT = 10;
export const TASK_DETAIL_COMMENTS_LIMIT = 10;
const TASK_DETAIL_DESCRIPTION_MAX = 2000;
const TASK_DETAIL_COMMENT_MAX = 500;

const TASK_STATUSES = Object.values(TaskStatus);
const DAY_MS = 24 * 60 * 60 * 1000;

export const FIND_TASKS_TOOL: Anthropic.Tool = {
  name: 'find_tasks',
  description:
    'Найти задачи по условиям: исполнитель, постановщик, статус, просрочка, срок, текст, встреча-источник. Возвращает до limit задач (по умолчанию 15, максимум 30; сначала просроченные и с ближайшим сроком) и счётчики по ВСЕЙ выборке: totalCount, overdueCount, byAssignee (у кого сколько задач и сколько из них просрочено), byStatus. Используй для вопросов «что у Ирины», «что просрочено и у кого», «задачи по вентшахте», «что горит на этой неделе», «что я поставил Жандосу». По умолчанию ищутся только открытые задачи (без выполненных и отменённых); выполненные — status ["DONE"]. Если задач больше, чем показано, отвечай по счётчикам и честно говори, что показаны не все. Исполнителя и постановщика передавай текстом, как их назвал пользователь — сервер сам найдёт сотрудника и переспросит, если имя неоднозначно.',
  input_schema: {
    type: 'object',
    properties: {
      assigneeRawText: {
        type: 'string',
        description:
          'Исполнитель, как назван: «Ирины», «у Жандоса», «Сергееву»',
      },
      unassigned: {
        type: 'boolean',
        description: 'true — только задачи без исполнителя',
      },
      creatorRawText: {
        type: 'string',
        description: 'Постановщик, как назван',
      },
      mine: {
        type: 'string',
        enum: ['assigned', 'created'],
        description:
          'assigned — задачи на самом пользователе, created — поставленные им',
      },
      status: {
        type: 'array',
        items: { type: 'string', enum: TASK_STATUSES },
        description: 'Статусы; не указывать — все открытые',
      },
      overdue: { type: 'boolean', description: 'true — только просроченные' },
      dueFrom: {
        type: 'string',
        description:
          'Срок не раньше — местное время без смещения, «2026-11-02T00:00:00»',
      },
      dueTo: {
        type: 'string',
        description:
          'Срок не позже — местное время без смещения, «2026-11-08T23:59:59»',
      },
      query: {
        type: 'string',
        description: 'Слово из названия или описания задачи',
      },
      sourceMeetingId: {
        type: 'string',
        description:
          'Только задачи, поставленные по этой встрече (id из инструментов встреч)',
      },
      limit: { type: 'integer', description: 'Сколько задач показать, 1–30' },
    },
    required: [],
  },
};

export const GET_TASK_TOOL: Anthropic.Tool = {
  name: 'get_task',
  description:
    'Открыть одну задачу целиком по id (из find_tasks/get_tasks, пометки [shown_task] или блока [page_context]): описание, исполнитель, постановщик, срок, источник, подзадачи, последние изменения и комментарии. Используй, когда спрашивают «почему просрочено», «что по этой задаче», «кто что писал», «когда переносили срок».',
  input_schema: {
    type: 'object',
    properties: { taskId: { type: 'string' } },
    required: ['taskId'],
  },
};

export interface FindTasksInput {
  assigneeRawText?: string;
  unassigned: boolean;
  creatorRawText?: string;
  mine?: 'assigned' | 'created';
  statuses: TaskStatus[];
  overdue: boolean;
  dueFrom?: Date;
  dueTo?: Date;
  query?: string;
  sourceMeetingId?: string;
  limit: number;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// Время модели — местное без смещения (как у dueDate в create_task);
// непонятная строка — фильтра нет, а не ошибка всего поиска.
function localDate(v: unknown): Date | undefined {
  const raw = text(v);
  if (!raw) return undefined;
  const date = new Date(withLocalOffset(raw) as string);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseFindTasksInput(input: unknown): FindTasksInput {
  const typed = (input ?? {}) as Record<string, unknown>;
  const rawLimit = Number(typed.limit);
  return {
    assigneeRawText: text(typed.assigneeRawText),
    unassigned: typed.unassigned === true,
    creatorRawText: text(typed.creatorRawText),
    mine:
      typed.mine === 'assigned' || typed.mine === 'created'
        ? typed.mine
        : undefined,
    statuses: Array.isArray(typed.status)
      ? typed.status.filter((s): s is TaskStatus =>
          TASK_STATUSES.includes(s as TaskStatus),
        )
      : [],
    overdue: typed.overdue === true,
    dueFrom: localDate(typed.dueFrom),
    dueTo: localDate(typed.dueTo),
    query: text(typed.query),
    sourceMeetingId: text(typed.sourceMeetingId),
    limit:
      Number.isFinite(rawLimit) && rawLimit >= 1
        ? Math.floor(rawLimit)
        : FIND_TASKS_DEFAULT_LIMIT,
  };
}

export interface FoundTaskData extends TaskCardData {
  priority: string;
  isOverdue: boolean;
  // Полных дней просрочки (0 — просрочена сегодня); null — не просрочена.
  daysOverdue: number | null;
  creator: string | null;
}

export function toFoundTask(
  t: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate: Date | null;
    isOverdue: boolean;
    assignee: { id: string; fullName: string } | null;
    creator: { fullName: string } | null;
  },
  now: Date = new Date(),
): FoundTaskData {
  return {
    taskId: t.id,
    title: t.title,
    status: t.status,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
    assignee: t.assignee
      ? { id: t.assignee.id, name: t.assignee.fullName }
      : null,
    priority: t.priority,
    isOverdue: t.isOverdue,
    daysOverdue:
      t.isOverdue && t.dueDate
        ? Math.floor((now.getTime() - t.dueDate.getTime()) / DAY_MS)
        : null,
    creator: t.creator?.fullName ?? null,
  };
}

// Карточка в чате — общий TaskCardData без служебных полей поиска.
export function toCard(t: FoundTaskData): TaskCardData {
  return {
    taskId: t.taskId,
    title: t.title,
    status: t.status,
    dueDate: t.dueDate,
    assignee: t.assignee,
  };
}

export function toGroupData(
  groups: TaskSearchGroup[],
): { name: string; count: number; overdue: number }[] {
  return groups.map(({ name, count, overdue }) => ({ name, count, overdue }));
}

export interface TaskDetailData extends FoundTaskData {
  description: string | null;
  // origin, а не source: у TaskCardData свой source (карточка задачи из встречи).
  origin: {
    meetingId: string;
    meetingTitle: string;
    timestamp: string | null;
    context: string | null;
  } | null;
  subtasks: { title: string; status: string; assignee: string | null }[];
  history: {
    field: string;
    from: string | null;
    to: string | null;
    by: string;
    at: string;
  }[];
  comments: { author: string; text: string; at: string }[];
  commentCount: number;
}

// Поля TaskHistory, где значения — id сотрудников (tasks.service.ts diff/remind).
export const HISTORY_EMPLOYEE_FIELDS: ReadonlySet<string> = new Set([
  'assigneeId',
  'remind',
]);

// id сотрудников из истории — чтобы подтянуть имена одним запросом.
export function historyEmployeeIds(
  history: {
    field: string;
    oldValue: string | null;
    newValue: string | null;
  }[],
): string[] {
  const ids = history
    .slice(0, TASK_DETAIL_HISTORY_LIMIT)
    .filter((h) => HISTORY_EMPLOYEE_FIELDS.has(h.field))
    .flatMap((h) => [h.oldValue, h.newValue])
    .filter((v): v is string => !!v);
  return [...new Set(ids)];
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function toTaskDetail(
  t: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueDate: Date | null;
    isOverdue: boolean;
    description: string | null;
    assignee: { id: string; fullName: string } | null;
    creator: { fullName: string } | null;
    sourceMeeting: { id: string; title: string } | null;
    sourceTimestamp: string | null;
    sourceContext: string | null;
    subtasks: {
      title: string;
      status: string;
      assignee: { fullName: string } | null;
    }[];
    // TasksService.findOne: история — новые сверху, комментарии — по порядку.
    history: {
      field: string;
      oldValue: string | null;
      newValue: string | null;
      createdAt: Date;
      // null — изменение системой (сотрудник удалён и т.п.).
      changedBy: { fullName: string } | null;
    }[];
    comments: { body: string; createdAt: Date; author: { fullName: string } }[];
  },
  // id сотрудника → имя: в истории исполнитель и «напомнил» хранятся id,
  // модели нужны имена.
  employeeNames: Map<string, string> = new Map(),
  now: Date = new Date(),
): TaskDetailData {
  const shown = (field: string, value: string | null) =>
    value && HISTORY_EMPLOYEE_FIELDS.has(field)
      ? (employeeNames.get(value) ?? value)
      : value;
  return {
    ...toFoundTask(t, now),
    description: t.description
      ? clip(t.description, TASK_DETAIL_DESCRIPTION_MAX)
      : null,
    origin: t.sourceMeeting
      ? {
          meetingId: t.sourceMeeting.id,
          meetingTitle: t.sourceMeeting.title,
          timestamp: t.sourceTimestamp,
          context: t.sourceContext,
        }
      : null,
    subtasks: t.subtasks.map((s) => ({
      title: s.title,
      status: s.status,
      assignee: s.assignee?.fullName ?? null,
    })),
    history: t.history.slice(0, TASK_DETAIL_HISTORY_LIMIT).map((h) => ({
      field: h.field,
      from: shown(h.field, h.oldValue),
      to: shown(h.field, h.newValue),
      by: h.changedBy?.fullName ?? 'система',
      at: h.createdAt.toISOString(),
    })),
    comments: t.comments.slice(-TASK_DETAIL_COMMENTS_LIMIT).map((c) => ({
      author: c.author.fullName,
      text: clip(c.body, TASK_DETAIL_COMMENT_MAX),
      at: c.createdAt.toISOString(),
    })),
    commentCount: t.comments.length,
  };
}

// ── Этап A2: изменение задач из чата ────────────────────────────────────
// Исполнение — через TasksService (его RBAC, история, уведомления), ключ
// повтора — AgentActionExecution, отмена — UndoRecord + POST /voice/undo.

const TASK_ID_PROP = {
  taskId: {
    type: 'string',
    description:
      'id задачи из find_tasks/get_task, [shown_task] или [page_context]',
  },
} as const;
const WRITE_RULES =
  'Вызывай только по прямой просьбе пользователя. id задачи — только из find_tasks/get_task, пометки [shown_task] или блока [page_context]; если пользователь говорит «эту задачу», а какую — неясно, сначала найди через find_tasks и переспроси при нескольких кандидатах. Выполняется сразу; у пользователя 30 секунд, чтобы отменить кнопкой на карточке.';

// Статусы, которые можно поставить из чата: черновик — служебный.
export const SETTABLE_TASK_STATUSES: TaskStatus[] = TASK_STATUSES.filter(
  (s) => s !== TaskStatus.DRAFT,
);

export const UPDATE_TASK_TOOL: Anthropic.Tool = {
  name: 'update_task',
  description: `Изменить задачу: название, описание, исполнителя, срок, приоритет («перенеси срок на пятницу», «передай Асель», «сделай срочной»). Передавай только то, что просят изменить. ${WRITE_RULES} Статус — через set_task_status.`,
  input_schema: {
    type: 'object',
    properties: {
      ...TASK_ID_PROP,
      title: { type: 'string' },
      description: { type: 'string' },
      assigneeRawText: {
        type: 'string',
        description:
          'Новый исполнитель, как прозвучал («Асель», «на Рустема») — сервер сам найдёт сотрудника',
      },
      unassign: { type: 'boolean', description: 'true — снять исполнителя' },
      dueDate: {
        type: 'string',
        description:
          'Новый срок — местное время без смещения; назван только день — 18:00 этого дня',
      },
      clearDueDate: { type: 'boolean', description: 'true — снять срок' },
      priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    },
    required: ['taskId'],
  },
};

export const SET_TASK_STATUS_TOOL: Anthropic.Tool = {
  name: 'set_task_status',
  description: `Перевести задачу в другой статус: NEW — новая, IN_PROGRESS — в работе, IN_REVIEW — на проверке, DONE — выполнена, RETURNED — вернуть на доработку, CANCELLED — отменить. Исполнитель может ставить только IN_PROGRESS/IN_REVIEW/DONE, руководство — любой (сервер проверит сам). ${WRITE_RULES}`,
  input_schema: {
    type: 'object',
    properties: {
      ...TASK_ID_PROP,
      status: { type: 'string', enum: SETTABLE_TASK_STATUSES },
    },
    required: ['taskId', 'status'],
  },
};

export const COMMENT_TASK_TOOL: Anthropic.Tool = {
  name: 'comment_task',
  description: `Написать комментарий к задаче от имени пользователя (его увидят постановщик/исполнитель и наблюдатели, им придёт уведомление). text — сам комментарий, как его написал бы пользователь. ${WRITE_RULES}`,
  input_schema: {
    type: 'object',
    properties: { ...TASK_ID_PROP, text: { type: 'string' } },
    required: ['taskId', 'text'],
  },
};

export const REMIND_TASK_TOOL: Anthropic.Tool = {
  name: 'remind_task',
  description: `Напомнить исполнителю о задаче сообщением в Telegram (не чаще раза в час на задачу). ${WRITE_RULES}`,
  input_schema: {
    type: 'object',
    properties: { ...TASK_ID_PROP },
    required: ['taskId'],
  },
};

export const DELETE_TASK_TOOL: Anthropic.Tool = {
  name: 'delete_task',
  description:
    'Удалить задачу навсегда, вместе с подзадачами и комментариями. Только когда пользователь прямо говорит «удали задачу»; «отмени», «не нужна» — это set_task_status CANCELLED. Отменить удаление нельзя. id — только из find_tasks/get_task, [shown_task] или [page_context].',
  input_schema: {
    type: 'object',
    properties: { ...TASK_ID_PROP },
    required: ['taskId'],
  },
};

export const TASK_WRITE_TOOLS: Anthropic.Tool[] = [
  UPDATE_TASK_TOOL,
  SET_TASK_STATUS_TOOL,
  COMMENT_TASK_TOOL,
  REMIND_TASK_TOOL,
  DELETE_TASK_TOOL,
];

export interface UpdateTaskInput {
  taskId: string;
  title?: string;
  description?: string;
  assigneeRawText?: string;
  unassign: boolean;
  // undefined — не менять, null — снять, строка — местное время со смещением.
  dueDate?: string | null;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function parseUpdateTaskInput(input: unknown): UpdateTaskInput {
  const typed = (input ?? {}) as Record<string, unknown>;
  const priority = typed.priority;
  const due = text(typed.dueDate);
  return {
    taskId: text(typed.taskId) ?? '',
    title: text(typed.title),
    // Описание можно очистить пустой строкой — её не теряем.
    description:
      typeof typed.description === 'string'
        ? typed.description.trim()
        : undefined,
    assigneeRawText: text(typed.assigneeRawText),
    unassign: typed.unassign === true,
    dueDate:
      typed.clearDueDate === true
        ? null
        : due
          ? withLocalOffset(due)
          : undefined,
    priority:
      priority === 'LOW' ||
      priority === 'MEDIUM' ||
      priority === 'HIGH' ||
      priority === 'CRITICAL'
        ? priority
        : undefined,
  };
}

export interface TaskChange {
  label: string;
  from: string | null;
  to: string | null;
}

const PRIORITY_RU: Record<string, string> = {
  LOW: 'низкий',
  MEDIUM: 'обычный',
  HIGH: 'высокий',
  CRITICAL: 'критичный',
};
const STATUS_RU: Record<string, string> = {
  DRAFT: 'Черновик',
  NEW: 'Новая',
  IN_PROGRESS: 'В работе',
  IN_REVIEW: 'На проверке',
  DONE: 'Выполнена',
  RETURNED: 'Возвращена на доработку',
  CANCELLED: 'Отменена',
};

// Срок для человека — по местному времени компании: «31.10, 18:00».
export function formatDue(date: Date | null): string | null {
  if (!date) return null;
  const local = new Date(
    date.getTime() + TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000,
  ).toISOString();
  return `${local.slice(8, 10)}.${local.slice(5, 7)}, ${local.slice(11, 16)}`;
}

interface TaskSnapshot {
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: Date | null;
  assignee: { id: string; fullName: string } | null;
}

// «Было → стало» для карточки: только реально изменившееся.
export function describeTaskChanges(
  before: TaskSnapshot,
  after: TaskSnapshot,
): TaskChange[] {
  const changes: TaskChange[] = [];
  const push = (label: string, from: string | null, to: string | null) => {
    if (from !== to) changes.push({ label, from, to });
  };
  push('Название', before.title, after.title);
  if ((before.description ?? '') !== (after.description ?? ''))
    changes.push({
      label: 'Описание',
      from: null,
      to: after.description ? 'изменено' : 'очищено',
    });
  push(
    'Статус',
    STATUS_RU[before.status] ?? before.status,
    STATUS_RU[after.status] ?? after.status,
  );
  push(
    'Приоритет',
    PRIORITY_RU[before.priority] ?? before.priority,
    PRIORITY_RU[after.priority] ?? after.priority,
  );
  push('Срок', formatDue(before.dueDate), formatDue(after.dueDate));
  push(
    'Исполнитель',
    before.assignee?.fullName ?? null,
    after.assignee?.fullName ?? null,
  );
  return changes;
}

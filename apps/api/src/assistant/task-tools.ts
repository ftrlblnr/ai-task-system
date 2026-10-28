import type Anthropic from '@anthropic-ai/sdk';
import { TaskStatus } from '@prisma/client';
import { withLocalOffset } from '../common/timezone';
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
      assigneeRawText: { type: 'string', description: 'Исполнитель, как назван: «Ирины», «у Жандоса», «Сергееву»' },
      unassigned: { type: 'boolean', description: 'true — только задачи без исполнителя' },
      creatorRawText: { type: 'string', description: 'Постановщик, как назван' },
      mine: { type: 'string', enum: ['assigned', 'created'], description: 'assigned — задачи на самом пользователе, created — поставленные им' },
      status: { type: 'array', items: { type: 'string', enum: TASK_STATUSES }, description: 'Статусы; не указывать — все открытые' },
      overdue: { type: 'boolean', description: 'true — только просроченные' },
      dueFrom: { type: 'string', description: 'Срок не раньше — местное время без смещения, «2026-11-02T00:00:00»' },
      dueTo: { type: 'string', description: 'Срок не позже — местное время без смещения, «2026-11-08T23:59:59»' },
      query: { type: 'string', description: 'Слово из названия или описания задачи' },
      sourceMeetingId: { type: 'string', description: 'Только задачи, поставленные по этой встрече (id из инструментов встреч)' },
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
    mine: typed.mine === 'assigned' || typed.mine === 'created' ? typed.mine : undefined,
    statuses: Array.isArray(typed.status) ? typed.status.filter((s): s is TaskStatus => TASK_STATUSES.includes(s as TaskStatus)) : [],
    overdue: typed.overdue === true,
    dueFrom: localDate(typed.dueFrom),
    dueTo: localDate(typed.dueTo),
    query: text(typed.query),
    sourceMeetingId: text(typed.sourceMeetingId),
    limit: Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : FIND_TASKS_DEFAULT_LIMIT,
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
    assignee: t.assignee ? { id: t.assignee.id, name: t.assignee.fullName } : null,
    priority: t.priority,
    isOverdue: t.isOverdue,
    daysOverdue: t.isOverdue && t.dueDate ? Math.floor((now.getTime() - t.dueDate.getTime()) / DAY_MS) : null,
    creator: t.creator?.fullName ?? null,
  };
}

// Карточка в чате — общий TaskCardData без служебных полей поиска.
export function toCard(t: FoundTaskData): TaskCardData {
  return { taskId: t.taskId, title: t.title, status: t.status, dueDate: t.dueDate, assignee: t.assignee };
}

export function toGroupData(groups: TaskSearchGroup[]): { name: string; count: number; overdue: number }[] {
  return groups.map(({ name, count, overdue }) => ({ name, count, overdue }));
}

export interface TaskDetailData extends FoundTaskData {
  description: string | null;
  source: { meetingId: string; meetingTitle: string; timestamp: string | null; context: string | null } | null;
  subtasks: { title: string; status: string; assignee: string | null }[];
  history: { field: string; from: string | null; to: string | null; by: string; at: string }[];
  comments: { author: string; text: string; at: string }[];
  commentCount: number;
}

// Поля TaskHistory, где значения — id сотрудников (tasks.service.ts diff/remind).
export const HISTORY_EMPLOYEE_FIELDS: ReadonlySet<string> = new Set(['assigneeId', 'remind']);

// id сотрудников из истории — чтобы подтянуть имена одним запросом.
export function historyEmployeeIds(history: { field: string; oldValue: string | null; newValue: string | null }[]): string[] {
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
    subtasks: { title: string; status: string; assignee: { fullName: string } | null }[];
    // TasksService.findOne: история — новые сверху, комментарии — по порядку.
    history: { field: string; oldValue: string | null; newValue: string | null; createdAt: Date; changedBy: { fullName: string } }[];
    comments: { body: string; createdAt: Date; author: { fullName: string } }[];
  },
  // id сотрудника → имя: в истории исполнитель и «напомнил» хранятся id,
  // модели нужны имена.
  employeeNames: Map<string, string> = new Map(),
  now: Date = new Date(),
): TaskDetailData {
  const shown = (field: string, value: string | null) => (value && HISTORY_EMPLOYEE_FIELDS.has(field) ? (employeeNames.get(value) ?? value) : value);
  return {
    ...toFoundTask(t, now),
    description: t.description ? clip(t.description, TASK_DETAIL_DESCRIPTION_MAX) : null,
    source: t.sourceMeeting ? { meetingId: t.sourceMeeting.id, meetingTitle: t.sourceMeeting.title, timestamp: t.sourceTimestamp, context: t.sourceContext } : null,
    subtasks: t.subtasks.map((s) => ({ title: s.title, status: s.status, assignee: s.assignee?.fullName ?? null })),
    history: t.history.slice(0, TASK_DETAIL_HISTORY_LIMIT).map((h) => ({
      field: h.field,
      from: shown(h.field, h.oldValue),
      to: shown(h.field, h.newValue),
      by: h.changedBy.fullName,
      at: h.createdAt.toISOString(),
    })),
    comments: t.comments.slice(-TASK_DETAIL_COMMENTS_LIMIT).map((c) => ({ author: c.author.fullName, text: clip(c.body, TASK_DETAIL_COMMENT_MAX), at: c.createdAt.toISOString() })),
    commentCount: t.comments.length,
  };
}

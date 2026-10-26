import type { TaskListItem } from '@ai-task-system/shared-types';

// Быстрые фильтры списка задач (редизайн web W3, docs/WEB_REDESIGN.md §4.4).
// Живут в ?filter=, чтобы ссылки с пульта и из агента открывали нужный срез.
// active/review — старые ссылки со счётчиков пульта: чипа у них нет, но
// фильтр работает и показывается снимаемым чипом.

export const TASK_FILTERS = ['all', 'mine', 'created', 'today', 'overdue'] as const;
export const EXTRA_FILTERS = ['active', 'review'] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number] | (typeof EXTRA_FILTERS)[number];

export const FILTER_LABELS: Record<TaskFilter, string> = {
  all: 'Все',
  mine: 'Мои',
  created: 'Поставил я',
  today: 'Сегодня',
  overdue: 'Просрочено',
  active: 'Активные',
  review: 'На проверке',
};

export function parseFilter(value: string | null): TaskFilter {
  return (TASK_FILTERS as readonly string[]).includes(value ?? '') || (EXTRA_FILTERS as readonly string[]).includes(value ?? '')
    ? (value as TaskFilter)
    : 'all';
}

// «Сегодня» — по календарю компании, не браузера.
const TZ = 'Asia/Almaty';
function localDay(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: TZ });
}

export function isClosed(task: TaskListItem): boolean {
  return task.status === 'DONE' || task.status === 'CANCELLED';
}

export function matchesFilter(task: TaskListItem, filter: TaskFilter, userId: string | undefined, today = localDay(new Date())): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'mine':
      return task.assignee?.id === userId;
    case 'created':
      return task.creator.id === userId;
    case 'today':
      return !!task.dueDate && localDay(new Date(task.dueDate)) === today;
    case 'overdue':
      return task.isOverdue;
    case 'active':
      return !isClosed(task);
    case 'review':
      return task.status === 'IN_REVIEW';
  }
}

// Счётчик на чипе — открытые задачи среза (закрытые счёт не раздувают).
export function filterCounts(tasks: TaskListItem[], userId: string | undefined): Record<TaskFilter, number> {
  const today = localDay(new Date());
  const open = tasks.filter((t) => !isClosed(t));
  const counts = {} as Record<TaskFilter, number>;
  for (const f of [...TASK_FILTERS, ...EXTRA_FILTERS]) counts[f] = open.filter((t) => matchesFilter(t, f, userId, today)).length;
  return counts;
}

export function pluralTasks(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} задача`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} задачи`;
  return `${n} задач`;
}

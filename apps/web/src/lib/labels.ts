import type { TaskPriority, TaskStatus, ConfidenceLevel } from '@ai-task-system/shared-types';

export const STATUS_LABELS: Record<TaskStatus, string> = {
  DRAFT: 'Черновик',
  NEW: 'Новая',
  IN_PROGRESS: 'В работе',
  IN_REVIEW: 'На проверке',
  DONE: 'Выполнена',
  RETURNED: 'Возвращена на доработку',
  CANCELLED: 'Отменена',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: 'Низкий',
  MEDIUM: 'Средний',
  HIGH: 'Высокий',
  CRITICAL: 'Критический',
};

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  HIGH: 'Высокая уверенность',
  MEDIUM: 'Средняя уверенность',
  LOW: 'Низкая уверенность',
};

// Статусы, которые может проставить сам подчинённый (раздел 10 ТЗ —
// возврат/отмена остаются решением руководителя). Держим в одном месте
// с apps/api/src/tasks/tasks.service.ts (EMPLOYEE_ALLOWED_STATUSES).
export const EMPLOYEE_SETTABLE_STATUSES: TaskStatus[] = ['IN_PROGRESS', 'IN_REVIEW', 'DONE'];

// Порядок колонок канбан-доски. Просроченная/отменённая — «боковые
// состояния» (раздел 13 ТЗ), поэтому визуально отделены от основного
// потока разделителем (см. .board-side-divider).
export const BOARD_COLUMNS: TaskStatus[] = [
  'DRAFT',
  'NEW',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
  'RETURNED',
];
// Просрочка (аудит 10.09.2026, п. 2.1) больше не отдельная колонка — это
// вычисляемый признак (TaskListItem.isOverdue), показывается красным чипом
// с датой прямо на карточке в её реальной колонке (см. kanban-board.tsx),
// а не отдельным "статусом", в который можно перетащить карточку.
export const BOARD_SIDE_COLUMNS: TaskStatus[] = ['CANCELLED'];

export const PRIORITY_CLASS: Record<TaskPriority, string> = {
  LOW: 'priority-low',
  MEDIUM: 'priority-medium',
  HIGH: 'priority-high',
  CRITICAL: 'priority-critical',
};

// Цвет точки-индикатора в заголовке колонки канбан-доски — семантический,
// не завязан на акцент интерфейса (см. artifact/dataviz-принцип: semantic
// color separate from brand accent).
export const STATUS_DOT_COLOR: Record<TaskStatus, string> = {
  DRAFT: 'var(--ink-faint)',
  NEW: 'var(--accent)',
  IN_PROGRESS: 'var(--warn)',
  IN_REVIEW: 'var(--accent)',
  DONE: 'var(--ok)',
  RETURNED: 'var(--danger)',
  CANCELLED: 'var(--ink-faint)',
};

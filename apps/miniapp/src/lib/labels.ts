// Идентично apps/web/src/lib/labels.ts — единый источник истины по смыслу,
// но пока не вынесено в shared-types, чтобы не тащить это решение молча
// (см. обсуждение дублирования типов в packages/shared-types).
import type { ReceptionRequestStatus, ReceptionRequestType, TaskPriority, TaskStatus } from '@ai-task-system/shared-types';

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

// Статусы, которые может проставить сам подчинённый — держим в одном месте
// с apps/api/src/tasks/tasks.service.ts (EMPLOYEE_ALLOWED_STATUSES).
export const EMPLOYEE_SETTABLE_STATUSES: TaskStatus[] = ['IN_PROGRESS', 'IN_REVIEW', 'DONE'];

export const STATUS_DOT_COLOR: Record<TaskStatus, string> = {
  DRAFT: 'var(--ink-faint)',
  NEW: 'var(--accent)',
  IN_PROGRESS: 'var(--warn)',
  IN_REVIEW: 'var(--accent)',
  DONE: 'var(--ok)',
  RETURNED: 'var(--danger)',
  CANCELLED: 'var(--ink-faint)',
};

// Приёмная: тип вопроса (форма подачи, очередь руководителя) и статус.
export const REQUEST_TYPE_LABELS: Record<ReceptionRequestType, string> = {
  DECISION: 'Решение',
  APPROVAL: 'Согласование',
  DISCUSSION: 'Обсуждение',
  HELP: 'Помощь',
};

export const RECEPTION_STATUS_LABELS: Record<ReceptionRequestStatus, string> = {
  WAITING: 'Ожидает',
  CALLED: 'Вызван',
  COMPLETED: 'Обсуждено',
  ANSWERED: 'Отвечено',
  DELEGATED: 'Разберитесь сами',
  REJECTED: 'Отклонено',
  WITHDRAWN: 'Отозвано',
};

// Пока нет навыков (ARMS фазы 3–4) — готовые вопросы ассистенту, без чипа
// модели. Одни и те же на «Сегодня» руководителя и над полем ввода ассистента.
export const QUICK_PROMPTS = ['Что у меня важного сегодня?', 'Подготовь меня к ближайшей встрече', 'Разбери просрочки по исполнителям', 'Итоги недели'];

'use client';

import { Check } from 'lucide-react';
import type { TaskListItem, TaskStatus } from '@ai-task-system/shared-types';
import { cx } from '@/components/ui';
import { Avatar } from '@/components/avatar';
import { STATUS_LABELS } from '@/lib/labels';

// Список задач (редизайн web W3, макет «Задачи»): галочка «выполнено»,
// название с источником, статус, исполнитель, срок. Клик — боковая
// карточка; выбранная строка подсвечена.

// Тон пилюли статуса по макету: новая — нейтральная, в работе — синяя,
// проверка — фиолетовая, просрочка — оранжевая, выполнена — бирюзовая.
function statusTone(task: TaskListItem): string {
  if (task.isOverdue) return 'over';
  const tones: Partial<Record<TaskStatus, string>> = { IN_PROGRESS: 'work', IN_REVIEW: 'review', DONE: 'done', RETURNED: 'over' };
  return tones[task.status] ?? 'new';
}

function formatDue(dueDate: string): string {
  return new Date(dueDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'Asia/Almaty' }).replace('.', '');
}

interface TaskListProps {
  tasks: TaskListItem[];
  selectedId: string | null;
  canToggleDone: (task: TaskListItem) => boolean;
  onOpen: (taskId: string) => void;
  onToggleDone: (task: TaskListItem) => void;
}

export function TaskList({ tasks, selectedId, canToggleDone, onOpen, onToggleDone }: TaskListProps) {
  return (
    <div className="task-table" role="list">
      <div className="task-table-head" aria-hidden="true">
        <span className="task-table-check" />
        <span className="task-table-title">Задача</span>
        <span className="task-table-status">Статус</span>
        <span className="task-table-who">Исполнитель</span>
        <span className="task-table-due">Срок</span>
      </div>
      {tasks.map((task) => {
        const done = task.status === 'DONE';
        const togglable = canToggleDone(task);
        return (
          <div key={task.id} role="listitem" className={cx('task-row', task.id === selectedId && 'is-selected', done && 'is-done')} data-task-id={task.id}>
            <button
              type="button"
              className={cx('task-check', done && 'is-checked')}
              aria-label={done ? 'Вернуть в работу' : 'Отметить выполненной'}
              aria-pressed={done}
              disabled={!togglable}
              title={togglable ? undefined : 'Отмечает исполнитель или руководитель'}
              onClick={() => onToggleDone(task)}
            >
              {done && <Check size={12} strokeWidth={3} />}
            </button>
            <button type="button" className="task-row-main" aria-current={task.id === selectedId || undefined} onClick={() => onOpen(task.id)}>
              <span className="task-row-title">{task.title}</span>
              {(task.source || task.fromAgent) && <span className="task-row-source">{task.source ?? 'Ассистент'}</span>}
            </button>
            <span className="task-table-status">
              <span className={`task-pill task-pill-${statusTone(task)}`}>{task.isOverdue ? 'Просрочена' : STATUS_LABELS[task.status]}</span>
            </span>
            <span className="task-table-who">
              {task.assignee ? (
                <>
                  <Avatar id={task.assignee.id} name={task.assignee.fullName} size={26} />
                  <span className="task-row-who">{task.assignee.fullName.split(' ')[0]}</span>
                </>
              ) : (
                <span className="task-row-who is-empty">—</span>
              )}
            </span>
            <span className={cx('task-table-due mono', task.isOverdue && 'is-overdue')}>{task.dueDate ? formatDue(task.dueDate) : '—'}</span>
          </div>
        );
      })}
    </div>
  );
}

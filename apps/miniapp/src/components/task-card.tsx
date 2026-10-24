'use client';

import { Check } from 'lucide-react';
import type { TaskListItem, TaskStatus } from '@ai-task-system/shared-types';
import { StatusPill, cx } from '@/components/ui';
import { Avatar } from '@/components/avatar';
import { companyDate, companyDayKey, companyTime } from '@/lib/company-time';
import { STATUS_LABELS } from '@/lib/labels';

// Карточка задачи (редизайн M3, MINIAPP_REDESIGN.md §4.3): чекбокс слева,
// название, статус + срок, аватар исполнителя. Чекбокс и сама карточка —
// две отдельные кнопки: вложенные интерактивные элементы недоступны с
// клавиатуры и читалок экрана.

// Срок: сегодня — время, иначе дата (по времени компании).
function dueLabel(dueDate: string): string {
  return companyDayKey(dueDate) === companyDayKey(new Date()) ? `сегодня ${companyTime(dueDate)}` : companyDate(dueDate);
}

export function TaskCard({
  task,
  next,
  busy,
  onAdvance,
  onOpen,
}: {
  task: TaskListItem;
  // Следующий статус, если пользователь вправе перевести задачу дальше
  // (см. nextTaskStatus в tasks-screen.tsx), иначе чекбокса нет.
  next: TaskStatus | null;
  busy?: boolean;
  onAdvance: () => void;
  onOpen: () => void;
}) {
  const done = task.status === 'DONE';
  return (
    <div className={cx('task-row', done && 'is-done')}>
      {next ? (
        <button
          type="button"
          className={cx('task-check', next === 'DONE' && 'is-final')}
          onClick={onAdvance}
          disabled={busy}
          aria-label={`Перевести «${task.title}» в статус «${STATUS_LABELS[next]}»`}
        >
          <Check size={16} strokeWidth={2.5} />
        </button>
      ) : (
        done && (
          <span className="task-check is-checked" aria-hidden="true">
            <Check size={16} strokeWidth={2.5} />
          </span>
        )
      )}
      <button type="button" className="task-row-main" onClick={onOpen}>
        <span className="task-row-text">
          <span className="task-row-title">{task.title}</span>
          <span className="task-row-meta">
            <StatusPill status={task.status} />
            {task.dueDate && <span className={cx('due', task.isOverdue && 'is-overdue')}>{dueLabel(task.dueDate)}</span>}
            {task.subtaskCount > 0 && (
              <span className="due">
                {task.subtaskDoneCount}/{task.subtaskCount}
              </span>
            )}
          </span>
        </span>
        {task.assignee && <Avatar id={task.assignee.id} name={task.assignee.fullName} size={32} />}
      </button>
    </div>
  );
}

'use client';

import type { DragEvent } from 'react';
import { CircleAlert, Calendar, FileAudio, ListChecks } from 'lucide-react';
import type { TaskListItem } from '@ai-task-system/shared-types';
import { StatusBadge, PriorityMark, AgentMark, cx } from '@/components/ui';
import { Avatar } from '@/components/avatar';

// Порт TaskCard (project/components/src/index.jsx) — заменяет .kanban-card.
// Приоритет теперь PriorityMark, не цветная левая рамка (шаг 6). fromAgent/
// source — implementation.md: «Ассистент» через AgentMark, название встречи
// через иконку file-audio, цвет ink-3.

export function TaskCard({
  task,
  draggable,
  dragging,
  dropBefore,
  onClick,
  onDragStart,
  onDragEnd,
  onCardDragOver,
  onCardDrop,
}: {
  task: TaskListItem;
  draggable?: boolean;
  dragging?: boolean;
  dropBefore?: boolean;
  onClick: () => void;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onCardDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onCardDrop?: (e: DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <article
      className={cx('ds-task', dragging && 'is-dragging', dropBefore && 'is-drop-before')}
      tabIndex={0}
      role="button"
      draggable={draggable}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onCardDragOver}
      onDrop={onCardDrop}
    >
      <h3 className="ds-task-title">{task.title}</h3>
      {(task.status || task.fromAgent || task.source) && (
        <div className="ds-task-meta">
          <StatusBadge status={task.status} />
          {task.fromAgent && (
            <span className="ds-task-origin">
              <AgentMark size={12} state="done" />
              Ассистент
            </span>
          )}
          {task.source && (
            <span className="ds-task-origin" style={{ color: 'var(--ink-3)' }}>
              <FileAudio size={13} strokeWidth={1.75} />
              {task.source}
            </span>
          )}
        </div>
      )}
      <div className="ds-task-foot">
        <PriorityMark priority={task.priority} showLabel={false} />
        {task.dueDate && (
          <span className={cx('ds-task-due', task.isOverdue && 'is-overdue')}>
            {task.isOverdue ? <CircleAlert size={13} strokeWidth={1.75} /> : <Calendar size={13} strokeWidth={1.75} />}
            {task.isOverdue ? 'Просрочена · ' : ''}
            {new Date(task.dueDate).toLocaleDateString('ru-RU')}
          </span>
        )}
        {task.subtaskCount > 0 && (
          <span className="ds-task-sub">
            <ListChecks size={13} strokeWidth={1.75} />
            {task.subtaskDoneCount}/{task.subtaskCount}
          </span>
        )}
        {task.assignee && <Avatar name={task.assignee.fullName} size={22} />}
      </div>
    </article>
  );
}

'use client';

import { CircleAlert, Calendar, FileAudio, ListChecks } from 'lucide-react';
import type { TaskListItem } from '@ai-task-system/shared-types';
import { StatusBadge, PriorityMark, AgentMark, cx } from '@/components/ui';
import { Avatar } from '@/components/avatar';

// Порт TaskCard (project/components/src/index.jsx) — та же карточка, что в
// web/components/task-card.tsx, без drag-свойств (Mini App — списки, не
// канбан).

export function TaskCard({ task, onClick }: { task: TaskListItem; onClick: () => void }) {
  return (
    <article className="ds-task" tabIndex={0} role="button" onClick={onClick}>
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

'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Bell, Maximize2, Sparkles, X } from 'lucide-react';
import type { TaskDetail } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { Alert, Button, IconButton } from '@/components/ui';
import { Avatar } from '@/components/avatar';
import { taskPermissions, useTaskDetail } from '@/components/task-detail/use-task-detail';
import { TaskComments, TaskHistory, TaskStatusCard } from '@/components/task-detail/task-sections';

// Боковая карточка задачи в списке (редизайн web W3, docs/WEB_REDESIGN.md
// §4.4) — открывается по ?task=<id>, «назад» в браузере её закрывает.
// Разделы — те же, что у полной страницы /tasks/[id] («развернуть»); здесь
// они без своих рамок (см. .task-side .ds-card).

const REMIND_INTERVAL_MS = 60 * 60 * 1000;

function lastRemindAt(task: TaskDetail): Date | null {
  const times = task.history.filter((h) => h.field === 'remind').map((h) => new Date(h.createdAt).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

function sourceLabel(task: TaskDetail): string {
  if (task.sourceMeeting) return `Встреча «${task.sourceMeeting.title}»`;
  if (task.fromAgent) return 'Ассистент';
  return task.source ?? 'Вручную';
}

interface TaskSideCardProps {
  taskId: string;
  onClose: () => void;
  onAskAgent: () => void;
  onChanged: (task: TaskDetail) => void;
}

export function TaskSideCard({ taskId, onClose, onAskAgent, onChanged }: TaskSideCardProps) {
  const { user } = useAuth();
  const t = useTaskDetail(taskId);
  const remindKey = useIdempotencyKey();
  const { task } = t;

  // Изменения из карточки (статус, напоминание) — сразу в строку списка.
  useEffect(() => {
    if (task) onChanged(task);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);

  const can = task ? taskPermissions(task, user) : null;
  const closed = task?.status === 'DONE' || task?.status === 'CANCELLED';
  const canRemind = !!task && !!can && (can.isManager || task.creator.id === user?.id) && !!task.assignee && task.assignee.id !== user?.id && !closed;
  const reminded = task ? lastRemindAt(task) : null;
  // eslint-disable-next-line react-hooks/purity -- окно «раз в час» сверяется со временем показа
  const remindBlocked = !!reminded && Date.now() - reminded.getTime() < REMIND_INTERVAL_MS;

  return (
    <aside className="task-side" aria-label="Карточка задачи">
      <header className="task-side-head">
        <span className="section-kicker">Задача</span>
        <span className="ds-spacer" />
        <Link href={`/tasks/${taskId}`} className="ds-iconbtn ds-iconbtn-sm" title="Развернуть" aria-label="Развернуть">
          <Maximize2 size={16} strokeWidth={1.9} />
        </Link>
        <IconButton icon={X} label="Закрыть карточку" size="sm" onClick={onClose} />
      </header>

      {t.error && <Alert tone="danger">{t.error}</Alert>}
      {!task && !t.error && <p className="ds-field-hint">Загрузка…</p>}

      {task && can && (
        <div className="task-side-body">
          <h2 className="task-side-title">{task.title}</h2>

          <dl className="task-side-fields">
            <dt>Исполнитель</dt>
            <dd>
              {task.assignee ? (
                <>
                  <Avatar id={task.assignee.id} name={task.assignee.fullName} size={22} />
                  {task.assignee.fullName}
                </>
              ) : (
                'не назначен'
              )}
            </dd>
            <dt>Поставил</dt>
            <dd>{task.creator.fullName}</dd>
            <dt>Срок</dt>
            <dd className={task.isOverdue ? 'is-overdue' : undefined}>
              {task.dueDate
                ? new Date(task.dueDate).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' })
                : '—'}
              {task.isOverdue && ' · просрочена'}
            </dd>
            <dt>Источник</dt>
            <dd>{sourceLabel(task)}</dd>
          </dl>

          {task.description && <p className="task-side-desc">{task.description}</p>}

          <div className="task-side-actions">
            {canRemind && (
              <Button
                variant="secondary"
                size="sm"
                icon={Bell}
                disabled={t.busy || remindBlocked}
                title={remindBlocked ? 'Напоминать можно не чаще раза в час' : undefined}
                onClick={() => void t.remind(remindKey)}
              >
                {remindBlocked && reminded
                  ? `Напомнили в ${reminded.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Almaty' })}`
                  : 'Напомнить исполнителю'}
              </Button>
            )}
            <Button variant="secondary" size="sm" icon={Sparkles} onClick={onAskAgent}>
              Спросить агента
            </Button>
          </div>

          <TaskStatusCard task={task} canChange={can.canChangeStatus} statuses={can.availableStatuses} busy={t.busy} onChange={(s) => void t.changeStatus(s)} />
          <TaskComments task={task} busy={t.busy} onSubmit={t.addComment} />
          <TaskHistory task={task} employees={t.employees} />
        </div>
      )}
    </aside>
  );
}

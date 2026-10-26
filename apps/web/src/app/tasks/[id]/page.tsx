'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CornerDownRight, Pencil, Trash2 } from 'lucide-react';
import { Protected } from '@/components/protected';
import { useAuth } from '@/lib/auth-context';
import { Alert, Button, PageHeader } from '@/components/ui';
import { taskPermissions, useTaskDetail } from '@/components/task-detail/use-task-detail';
import { useAgentContext } from '@/components/agent-panel/agent-context';
import {
  TaskComments,
  TaskEditForm,
  TaskHistory,
  TaskMetaBadges,
  TaskSource,
  TaskStatusCard,
  TaskSubtasks,
  TaskWatchers,
} from '@/components/task-detail/task-sections';

// Полная страница задачи (прямые ссылки, «развернуть» из боковой карточки).
// Разделы — components/task-detail/* (редизайн web W0).

function TaskDetailView({ id }: { id: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const t = useTaskDetail(id);
  const [editing, setEditing] = useState(false);
  const { task } = t;
  useAgentContext(task ? { kind: 'task', id: task.id, label: task.title } : null);

  async function removeTask() {
    if (!task) return;
    if (!window.confirm(`Удалить задачу «${task.title}»? Это действие необратимо.`)) return;
    if (await t.remove()) router.push('/tasks');
  }

  if (t.error) return <Alert tone="danger">{t.error}</Alert>;
  if (!task) return <p className="ds-field-hint">Загрузка…</p>;

  const can = taskPermissions(task, user);

  return (
    <div className="task-detail">
      {task.parentTask && (
        <Link href={`/tasks/${task.parentTask.id}`} className="back-link">
          <CornerDownRight size={14} strokeWidth={2.25} />
          Подзадача — {task.parentTask.title}
        </Link>
      )}
      <PageHeader
        title={task.title}
        actions={
          <>
            {can.canDelete && !editing && (
              <Button variant="secondary" size="sm" icon={Pencil} onClick={() => setEditing(true)} disabled={t.busy} aria-label="Редактировать задачу">
                Редактировать
              </Button>
            )}
            {can.canDelete && (
              <Button variant="secondary" size="sm" icon={Trash2} onClick={removeTask} disabled={t.busy} aria-label="Удалить задачу">
                Удалить
              </Button>
            )}
          </>
        }
      />

      {editing ? (
        <TaskEditForm
          task={task}
          employees={t.employees}
          busy={t.busy}
          onSave={async (fields) => {
            if (await t.saveEdit(fields)) setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <TaskMetaBadges task={task} />
      )}

      <TaskWatchers
        task={task}
        employees={t.employees}
        userId={user?.id}
        isManager={can.isManager}
        isWatching={can.isWatching}
        busy={t.busy}
        onToggle={() => void t.toggleWatch(can.isWatching, user?.id)}
        onAdd={t.addWatcher}
        onRemove={(employeeId) => void t.removeWatcher(employeeId)}
      />

      {task.description && <p className="task-description">{task.description}</p>}

      <TaskSource task={task} isManager={can.isManager} />
      <TaskStatusCard task={task} canChange={can.canChangeStatus} statuses={can.availableStatuses} busy={t.busy} onChange={(s) => void t.changeStatus(s)} />
      <TaskComments task={task} busy={t.busy} onSubmit={t.addComment} />
      {!task.parentTask && <TaskSubtasks task={task} employees={t.employees} busy={t.busy} onAdd={t.addSubtask} />}
      <TaskHistory task={task} employees={t.employees} />
    </div>
  );
}

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Protected>
      <TaskDetailView id={id} />
    </Protected>
  );
}

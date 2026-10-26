'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, FileAudio } from 'lucide-react';
import type { EmployeeSummary, TaskDetail, TaskPriority, TaskStatus } from '@ai-task-system/shared-types';
import { Avatar } from '@/components/avatar';
import { Badge, Button, Card, Chip, Field, Input, Select, Textarea, cx } from '@/components/ui';
import { STATUS_LABELS, STATUS_DOT_COLOR, CONFIDENCE_LABELS, PRIORITY_LABELS } from '@/lib/labels';
import type { TaskEditFields } from './use-task-detail';

// Разделы карточки задачи. Вынесено из app/tasks/[id]/page.tsx (редизайн
// web W0) без изменения вида и поведения — их собирают страница задачи и
// боковая карточка (W3).

export function TaskMetaBadges({ task }: { task: TaskDetail }) {
  return (
    <div className="task-meta">
      <Badge tone={task.status === 'DONE' ? 'ok' : task.status === 'RETURNED' ? 'danger' : 'neutral'} dot>
        {STATUS_LABELS[task.status]}
      </Badge>
      {task.aiConfidence && <Badge>{CONFIDENCE_LABELS[task.aiConfidence]}</Badge>}
      {task.assignee && <Badge>Исполнитель: {task.assignee.fullName}</Badge>}
      <Badge>Постановщик: {task.creator.fullName}</Badge>
      {task.dueDate && <Badge>Срок: {new Date(task.dueDate).toLocaleDateString('ru-RU')}</Badge>}
    </div>
  );
}

interface EditFormProps {
  task: TaskDetail;
  employees: EmployeeSummary[];
  busy: boolean;
  onSave: (fields: TaskEditFields) => void;
  onCancel: () => void;
}

// Поля заполняются из задачи при открытии формы.
export function TaskEditForm({ task, employees, busy, onSave, onCancel }: EditFormProps) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [assigneeId, setAssigneeId] = useState(task.assignee?.id ?? '');
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate ? task.dueDate.slice(0, 10) : '');

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave({ title, description, assigneeId, priority, dueDate });
  }

  return (
    <form onSubmit={submit} className="ds-card" style={{ marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
      <Field label="Название">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <Field label="Описание">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </Field>
      <Field label="Исполнитель">
        <Select
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          options={[{ value: '', label: 'Не назначен' }, ...employees.map((emp) => ({ value: emp.id, label: emp.fullName }))]}
        />
      </Field>
      <Field label="Приоритет">
        <Select
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority)}
          options={(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
        />
      </Field>
      <Field label="Срок">
        <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
          Сохранить
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

interface WatchersProps {
  task: TaskDetail;
  employees: EmployeeSummary[];
  userId: string | undefined;
  isManager: boolean;
  isWatching: boolean;
  busy: boolean;
  onToggle: () => void;
  onAdd: (employeeId: string) => Promise<boolean>;
  onRemove: (employeeId: string) => void;
}

export function TaskWatchers({ task, employees, userId, isManager, isWatching, busy, onToggle, onAdd, onRemove }: WatchersProps) {
  const [addWatcherId, setAddWatcherId] = useState('');
  // Владелец добавляет наблюдателем любого; выбор ограничен теми, кто ещё
  // не наблюдает и не сам актор (себя добавляют кнопкой «Наблюдать» ниже).
  const watchableEmployees = employees.filter((e) => e.id !== userId && !task.watchers.some((w) => w.id === e.id));

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!addWatcherId) return;
    if (await onAdd(addWatcherId)) setAddWatcherId('');
  }

  return (
    <div className="watchers-row">
      <Button variant="ghost" size="sm" icon={isWatching ? EyeOff : Eye} onClick={onToggle} disabled={busy}>
        {isWatching ? 'Не наблюдать' : 'Наблюдать'}
      </Button>
      {task.watchers.length > 0 && (
        <div className="watchers-avatars" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {task.watchers.map((w) => (
            <Chip key={w.id} avatar={w.fullName} onRemove={isManager ? () => onRemove(w.id) : undefined}>
              {w.fullName}
            </Chip>
          ))}
        </div>
      )}
      {isManager && watchableEmployees.length > 0 && (
        <form className="watcher-add-form" onSubmit={add} style={{ display: 'flex', gap: 8 }}>
          <Select
            value={addWatcherId}
            onChange={(e) => setAddWatcherId(e.target.value)}
            options={[{ value: '', label: '+ Добавить наблюдателя…' }, ...watchableEmployees.map((e) => ({ value: e.id, label: e.fullName }))]}
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!addWatcherId || busy}>
            Добавить
          </Button>
        </form>
      )}
    </div>
  );
}

export function TaskSource({ task, isManager }: { task: TaskDetail; isManager: boolean }) {
  if (!task.sourceMeeting && !task.sourceContext) return null;
  return (
    <Card tone="agent" title="Источник">
      <div className="source-row">
        <FileAudio size={16} strokeWidth={1.75} className="source-icon" />
        <div>
          {task.sourceMeeting &&
            (isManager ? (
              <Link href={`/meetings/${task.sourceMeeting.id}`}>
                {task.sourceMeeting.title} · {new Date(task.sourceMeeting.meetingDate).toLocaleDateString('ru-RU')}
              </Link>
            ) : (
              <span>
                {task.sourceMeeting.title} · {new Date(task.sourceMeeting.meetingDate).toLocaleDateString('ru-RU')}
              </span>
            ))}
          {task.sourceTimestamp && (
            <span className="mono" style={{ marginLeft: task.sourceMeeting ? 8 : 0 }}>
              {task.sourceTimestamp}
            </span>
          )}
          {task.sourceContext && (
            <p className="ds-field-hint" style={{ marginTop: 6 }}>
              {task.sourceContext}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

interface StatusProps {
  task: TaskDetail;
  canChange: boolean;
  statuses: TaskStatus[];
  busy: boolean;
  onChange: (status: TaskStatus) => void;
}

export function TaskStatusCard({ task, canChange, statuses, busy, onChange }: StatusProps) {
  return (
    <Card title="Статус">
      {canChange ? (
        // Чипы с переносом, а не SegmentedControl: 7 статусов в одну
        // строку не помещались рядом с панелью агента (W2).
        <div className="pill-chips" role="group" aria-label="Статус задачи">
          {statuses.map((status) => (
            <button
              key={status}
              type="button"
              className={cx('pill-chip', task.status === status && 'is-active')}
              aria-pressed={task.status === status}
              disabled={busy}
              onClick={() => status !== task.status && onChange(status)}
            >
              {STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      ) : (
        <p className="ds-field-hint">Статус меняет исполнитель задачи или руководитель.</p>
      )}
    </Card>
  );
}

export function TaskComments({ task, busy, onSubmit }: { task: TaskDetail; busy: boolean; onSubmit: (body: string) => Promise<boolean> }) {
  const [comment, setComment] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    if (await onSubmit(comment)) setComment('');
  }

  return (
    <Card title="Комментарии">
      <ul className="comment-list">
        {task.comments.map((c) => (
          <li key={c.id} className="comment-item">
            <Avatar id={c.author.id} name={c.author.fullName} size={28} />
            <div className="comment-body">
              <div className="comment-head">
                <span className="comment-author">{c.author.fullName}</span>
                <span className="comment-time">{new Date(c.createdAt).toLocaleString('ru-RU')}</span>
              </div>
              <p>{c.body}</p>
            </div>
          </li>
        ))}
        {task.comments.length === 0 && <p className="ds-field-hint">Пока нет комментариев.</p>}
      </ul>
      <form onSubmit={submit} className="comment-form" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Добавить комментарий…" rows={3} />
        <Button type="submit" variant="primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>
          Отправить
        </Button>
      </form>
    </Card>
  );
}

interface SubtasksProps {
  task: TaskDetail;
  employees: EmployeeSummary[];
  busy: boolean;
  onAdd: (title: string, assigneeId: string) => Promise<boolean>;
}

export function TaskSubtasks({ task, employees, busy, onAdd }: SubtasksProps) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    if (await onAdd(title.trim(), assigneeId)) {
      setTitle('');
      setAssigneeId('');
    }
  }

  return (
    <Card title={`Подзадачи${task.subtaskCount > 0 ? ` (${task.subtaskDoneCount}/${task.subtaskCount})` : ''}`}>
      {task.subtasks.length === 0 && <p className="ds-field-hint">Пока нет подзадач.</p>}
      <ul className="plain-list">
        {task.subtasks.map((s) => (
          <li key={s.id} className="plain-list-row subtask-row" onClick={() => router.push(`/tasks/${s.id}`)}>
            <span className="subtask-title-group">
              <span className="status-dot-inline" style={{ background: STATUS_DOT_COLOR[s.status] }} />
              {s.title}
            </span>
            {s.assignee && <Avatar id={s.assignee.id} name={s.assignee.fullName} size={20} />}
          </li>
        ))}
      </ul>
      <form className="subtask-add-form" onSubmit={add} style={{ display: 'flex', gap: 8 }}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="+ Добавить подзадачу…" />
        <Select
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          style={{ maxWidth: 160 }}
          options={[{ value: '', label: 'Без исполнителя' }, ...employees.map((emp) => ({ value: emp.id, label: emp.fullName }))]}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={!title.trim() || busy}>
          Добавить
        </Button>
      </form>
    </Card>
  );
}

// История изменений (аудит 10.09.2026, п. 2.3) — TaskHistory уже писался
// бэкендом, но нигде не отображался. Метки полей — тот же список, что
// теперь отслеживает TasksService.diff().
const HISTORY_FIELD_LABELS: Record<string, string> = {
  title: 'Название',
  assigneeId: 'Исполнитель',
  priority: 'Приоритет',
  status: 'Статус',
  dueDate: 'Срок',
  description: 'Описание',
  taskProfileId: 'Профиль задачи',
  remind: 'Напоминание исполнителю',
};

export function TaskHistory({ task, employees }: { task: TaskDetail; employees: EmployeeSummary[] }) {
  // Резолвим id в имя/подпись там, где это возможно — история хранит сырые
  // значения (см. TasksService.diff), сотрудники уже загружены карточкой.
  function formatValue(field: string, value: string | null): string {
    if (value === null) return '—';
    if (field === 'assigneeId') return employees.find((e) => e.id === value)?.fullName ?? value;
    if (field === 'priority') return PRIORITY_LABELS[value as TaskPriority] ?? value;
    if (field === 'status') return STATUS_LABELS[value as TaskStatus] ?? value;
    if (field === 'dueDate') return new Date(value).toLocaleDateString('ru-RU');
    return value;
  }

  return (
    <Card title="История изменений">
      {task.history.length === 0 && <p className="ds-field-hint">Пока нет изменений.</p>}
      <ul className="plain-list">
        {task.history.map((h) => (
          <li key={h.id} className="plain-list-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <span className="body-sm" style={{ color: 'var(--ink-3)' }}>
              {h.changedBy?.fullName ?? 'Система'} · {new Date(h.createdAt).toLocaleString('ru-RU')}
            </span>
            <span className="body-sm" style={{ color: 'var(--ink-2)' }}>
              {h.field === 'remind'
                ? `${HISTORY_FIELD_LABELS.remind}: ${formatValue('assigneeId', h.newValue)}`
                : `${HISTORY_FIELD_LABELS[h.field] ?? h.field}: ${formatValue(h.field, h.oldValue)} → ${formatValue(h.field, h.newValue)}`}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

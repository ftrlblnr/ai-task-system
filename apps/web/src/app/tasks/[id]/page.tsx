'use client';

import { use, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CornerDownRight, Eye, EyeOff, FileAudio, Pencil, Trash2 } from 'lucide-react';
import type { EmployeeSummary, TaskDetail, TaskPriority, TaskStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { useAuth } from '@/lib/auth-context';
import { Avatar } from '@/components/avatar';
import {
  STATUS_LABELS,
  STATUS_DOT_COLOR,
  CONFIDENCE_LABELS,
  EMPLOYEE_SETTABLE_STATUSES,
  PRIORITY_LABELS,
} from '@/lib/labels';

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
};

function TaskDetailView({ id }: { id: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [subtaskTitle, setSubtaskTitle] = useState('');
  const [subtaskAssigneeId, setSubtaskAssigneeId] = useState('');
  const [addWatcherId, setAddWatcherId] = useState('');
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editAssigneeId, setEditAssigneeId] = useState('');
  const [editPriority, setEditPriority] = useState<TaskPriority>('MEDIUM');
  const [editDueDate, setEditDueDate] = useState('');

  function load() {
    api
      .get<TaskDetail>(`/tasks/${id}`)
      .then(setTask)
      .catch(() => setError('Не удалось загрузить задачу — возможно, у вас нет к ней доступа'));
  }

  useEffect(load, [id]);
  // Список сотрудников — только для формы «добавить наблюдателя»
  // (владелец), задача создателя подзадачи не требует отдельного пикера.
  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => {});
  }, []);

  async function changeStatus(status: TaskStatus) {
    setBusy(true);
    try {
      const updated = await api.patch<TaskDetail>(`/tasks/${id}/status`, { status });
      setTask(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось изменить статус');
    } finally {
      setBusy(false);
    }
  }

  async function submitComment(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    setBusy(true);
    try {
      const updated = await api.post<TaskDetail>(`/tasks/${id}/comments`, { body: comment });
      setTask(updated);
      setComment('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить комментарий');
    } finally {
      setBusy(false);
    }
  }

  async function removeTask() {
    if (!task) return;
    if (!window.confirm(`Удалить задачу «${task.title}»? Это действие необратимо.`)) return;
    setBusy(true);
    try {
      await api.delete(`/tasks/${id}`);
      router.push('/tasks');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить задачу');
      setBusy(false);
    }
  }

  // Подзадача — обычная задача с parentTaskId (владелец 08.09.2026, по
  // образцу Linear/Asana), создаётся прямо из карточки родителя, без
  // отдельной формы/страницы.
  async function addSubtask(e: FormEvent) {
    e.preventDefault();
    if (!subtaskTitle.trim()) return;
    setBusy(true);
    try {
      await api.post('/tasks', {
        title: subtaskTitle.trim(),
        parentTaskId: id,
        assigneeId: subtaskAssigneeId || undefined,
      });
      setSubtaskTitle('');
      setSubtaskAssigneeId('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить подзадачу');
    } finally {
      setBusy(false);
    }
  }

  // Владелец 08.09.2026: редактирование задачи было в API (PATCH /tasks/:id),
  // но нигде не было формы для него на фронте.
  function startEdit() {
    if (!task) return;
    setEditTitle(task.title);
    setEditDescription(task.description ?? '');
    setEditAssigneeId(task.assignee?.id ?? '');
    setEditPriority(task.priority);
    setEditDueDate(task.dueDate ? task.dueDate.slice(0, 10) : '');
    setEditing(true);
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // null, а не undefined, для assigneeId/dueDate — иначе снять
      // исполнителя/срок через редактирование было бы невозможно:
      // Prisma игнорирует undefined-поля в update(), а не обнуляет их.
      const updated = await api.patch<TaskDetail>(`/tasks/${id}`, {
        title: editTitle,
        description: editDescription || undefined,
        assigneeId: editAssigneeId || null,
        priority: editPriority,
        dueDate: editDueDate ? new Date(editDueDate).toISOString() : null,
      });
      setTask(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить изменения');
    } finally {
      setBusy(false);
    }
  }

  async function toggleWatch(isWatching: boolean) {
    setBusy(true);
    try {
      if (isWatching) await api.delete(`/tasks/${id}/watchers/${user?.id}`);
      else await api.post(`/tasks/${id}/watchers`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось изменить наблюдение');
    } finally {
      setBusy(false);
    }
  }

  async function addWatcher(e: FormEvent) {
    e.preventDefault();
    if (!addWatcherId) return;
    setBusy(true);
    try {
      await api.post(`/tasks/${id}/watchers`, { employeeId: addWatcherId });
      setAddWatcherId('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить наблюдателя');
    } finally {
      setBusy(false);
    }
  }

  async function removeWatcher(employeeId: string) {
    setBusy(true);
    try {
      await api.delete(`/tasks/${id}/watchers/${employeeId}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось убрать наблюдателя');
    } finally {
      setBusy(false);
    }
  }

  // Резолвим id в имя/подпись там, где это возможно — история хранит сырые
  // значения (см. TasksService.diff), employees уже загружены на странице
  // ради формы наблюдателей, отдельный запрос не нужен.
  function formatHistoryValue(field: string, value: string | null): string {
    if (value === null) return '—';
    if (field === 'assigneeId') return employees.find((e) => e.id === value)?.fullName ?? value;
    if (field === 'priority') return PRIORITY_LABELS[value as TaskPriority] ?? value;
    if (field === 'status') return STATUS_LABELS[value as TaskStatus] ?? value;
    if (field === 'dueDate') return new Date(value).toLocaleDateString('ru-RU');
    return value;
  }

  if (error) return <p className="error">{error}</p>;
  if (!task) return <p className="hint">Загрузка…</p>;

  const isOwner = user?.role === 'OWNER';
  // Раздел 5/10 ТЗ (скорректировано 28.08.2026): видеть задачу может и
  // постановщик, но менять статус — только исполнитель или руководитель.
  const canChangeStatus = isOwner || task.assignee?.id === user?.id;
  const availableStatuses = isOwner ? (Object.keys(STATUS_LABELS) as TaskStatus[]) : EMPLOYEE_SETTABLE_STATUSES;
  // Удалить может тот же круг, что и редактировать (см. TasksService.remove
  // на бэкенде — это реальная граница, кнопка здесь просто её отражает).
  const canDelete = isOwner || task.creator.id === user?.id;
  const isWatching = task.watchers.some((w) => w.id === user?.id);
  // Владелец добавляет наблюдателем любого; выбор ограничен теми, кто ещё
  // не наблюдает и не сам актор (себя добавляют кнопкой «Наблюдать» ниже).
  const watchableEmployees = employees.filter(
    (e) => e.id !== user?.id && !task.watchers.some((w) => w.id === e.id),
  );

  return (
    <div className="task-detail">
      {task.parentTask && (
        <Link href={`/tasks/${task.parentTask.id}`} className="back-link">
          <CornerDownRight size={14} strokeWidth={2.25} />
          Подзадача — {task.parentTask.title}
        </Link>
      )}
      <div className="page-header">
        <h1>{task.title}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {canDelete && !editing && (
            <button className="btn-secondary btn-small" onClick={startEdit} disabled={busy} aria-label="Редактировать задачу">
              <Pencil size={14} strokeWidth={2} />
              Редактировать
            </button>
          )}
          {canDelete && (
            <button className="btn-secondary btn-small" onClick={removeTask} disabled={busy} aria-label="Удалить задачу">
              <Trash2 size={14} strokeWidth={2} />
              Удалить
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <form onSubmit={saveEdit} className="card form-card" style={{ marginBottom: 18 }}>
          <label>
            Название
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required />
          </label>
          <label>
            Описание
            <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={3} />
          </label>
          <label>
            Исполнитель
            <select value={editAssigneeId} onChange={(e) => setEditAssigneeId(e.target.value)}>
              <option value="">Не назначен</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.fullName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Приоритет
            <select value={editPriority} onChange={(e) => setEditPriority(e.target.value as TaskPriority)}>
              {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Срок
            <input type="date" value={editDueDate} onChange={(e) => setEditDueDate(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={busy || !editTitle.trim()}>
              Сохранить
            </button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(false)} disabled={busy}>
              Отмена
            </button>
          </div>
        </form>
      ) : (
        <div className="task-meta">
          <span className={`badge status-${task.status.toLowerCase()}`}>{STATUS_LABELS[task.status]}</span>
          {task.aiConfidence && <span className="badge badge-muted">{CONFIDENCE_LABELS[task.aiConfidence]}</span>}
          {task.assignee && <span className="badge badge-muted">Исполнитель: {task.assignee.fullName}</span>}
          <span className="badge badge-muted">Постановщик: {task.creator.fullName}</span>
          {task.dueDate && (
            <span className="badge badge-muted">Срок: {new Date(task.dueDate).toLocaleDateString('ru-RU')}</span>
          )}
        </div>
      )}

      <div className="watchers-row">
        <button className="btn-link" onClick={() => toggleWatch(isWatching)} disabled={busy}>
          {isWatching ? <EyeOff size={14} strokeWidth={2.1} /> : <Eye size={14} strokeWidth={2.1} />}
          {isWatching ? 'Не наблюдать' : 'Наблюдать'}
        </button>
        {task.watchers.length > 0 && (
          <div className="watchers-avatars">
            {task.watchers.map((w) => (
              <span key={w.id} className="watcher-chip" title={w.fullName}>
                <Avatar name={w.fullName} size={20} />
                {isOwner && (
                  <button
                    type="button"
                    className="watcher-remove"
                    onClick={() => removeWatcher(w.id)}
                    aria-label={`Убрать ${w.fullName} из наблюдателей`}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        {isOwner && watchableEmployees.length > 0 && (
          <form className="watcher-add-form" onSubmit={addWatcher}>
            <select value={addWatcherId} onChange={(e) => setAddWatcherId(e.target.value)}>
              <option value="">+ Добавить наблюдателя…</option>
              {watchableEmployees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary btn-small" disabled={!addWatcherId || busy}>
              Добавить
            </button>
          </form>
        )}
      </div>

      {task.description && <p className="task-description">{task.description}</p>}

      {(task.sourceMeeting || task.sourceContext) && (
        <div className="card source-card">
          <h2>Источник</h2>
          <div className="source-row">
            <FileAudio size={16} strokeWidth={2} className="source-icon" />
            <div>
              {task.sourceMeeting &&
                (user?.role === 'OWNER' ? (
                  <Link href={`/meetings/${task.sourceMeeting.id}`}>
                    {task.sourceMeeting.title} · {new Date(task.sourceMeeting.meetingDate).toLocaleDateString('ru-RU')}
                  </Link>
                ) : (
                  <span>
                    {task.sourceMeeting.title} · {new Date(task.sourceMeeting.meetingDate).toLocaleDateString('ru-RU')}
                  </span>
                ))}
              {task.sourceTimestamp && (
                <span className="chip mono" style={{ marginLeft: task.sourceMeeting ? 8 : 0 }}>
                  {task.sourceTimestamp}
                </span>
              )}
              {task.sourceContext && <p className="hint" style={{ marginTop: 6 }}>{task.sourceContext}</p>}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Статус</h2>
        {canChangeStatus ? (
          <div className="status-pill-group">
            {availableStatuses.map((status) => (
              <button
                key={status}
                className={`status-pill ${status === task.status ? 'current' : ''}`}
                disabled={busy || status === task.status}
                onClick={() => changeStatus(status)}
              >
                {STATUS_LABELS[status]}
              </button>
            ))}
          </div>
        ) : (
          <p className="hint">Статус меняет исполнитель задачи или руководитель.</p>
        )}
      </div>

      <div className="card">
        <h2>Комментарии</h2>
        <ul className="comment-list">
          {task.comments.map((c) => (
            <li key={c.id} className="comment-item">
              <Avatar name={c.author.fullName} size={28} />
              <div className="comment-body">
                <div className="comment-head">
                  <span className="comment-author">{c.author.fullName}</span>
                  <span className="comment-time">{new Date(c.createdAt).toLocaleString('ru-RU')}</span>
                </div>
                <p>{c.body}</p>
              </div>
            </li>
          ))}
          {task.comments.length === 0 && <p className="hint">Пока нет комментариев.</p>}
        </ul>
        <form onSubmit={submitComment} className="comment-form">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Добавить комментарий…"
            rows={3}
          />
          <button type="submit" disabled={busy} style={{ alignSelf: 'flex-start' }}>
            Отправить
          </button>
        </form>
      </div>

      {!task.parentTask && (
        <div className="card">
          <h2>
            Подзадачи{task.subtaskCount > 0 && ` (${task.subtaskDoneCount}/${task.subtaskCount})`}
          </h2>
          {task.subtasks.length === 0 && <p className="hint">Пока нет подзадач.</p>}
          <ul className="plain-list">
            {task.subtasks.map((s) => (
              <li key={s.id} className="plain-list-row subtask-row" onClick={() => router.push(`/tasks/${s.id}`)}>
                <span className="subtask-title-group">
                  <span className="status-dot-inline" style={{ background: STATUS_DOT_COLOR[s.status] }} />
                  {s.title}
                </span>
                {s.assignee && <Avatar name={s.assignee.fullName} size={20} />}
              </li>
            ))}
          </ul>
          <form className="subtask-add-form" onSubmit={addSubtask}>
            <input
              value={subtaskTitle}
              onChange={(e) => setSubtaskTitle(e.target.value)}
              placeholder="+ Добавить подзадачу…"
            />
            <select
              value={subtaskAssigneeId}
              onChange={(e) => setSubtaskAssigneeId(e.target.value)}
              style={{ maxWidth: 160 }}
            >
              <option value="">Без исполнителя</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.fullName}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary btn-small" disabled={!subtaskTitle.trim() || busy}>
              Добавить
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>История изменений</h2>
        {task.history.length === 0 && <p className="hint">Пока нет изменений.</p>}
        <ul className="plain-list">
          {task.history.map((h) => (
            <li key={h.id} className="plain-list-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
              <span className="hint">
                {h.changedBy?.fullName ?? 'Система'} · {new Date(h.createdAt).toLocaleString('ru-RU')}
              </span>
              <span>
                {HISTORY_FIELD_LABELS[h.field] ?? h.field}: {formatHistoryValue(h.field, h.oldValue)} →{' '}
                {formatHistoryValue(h.field, h.newValue)}
              </span>
            </li>
          ))}
        </ul>
      </div>
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

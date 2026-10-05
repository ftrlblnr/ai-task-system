'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import type { EmployeeSummary, TaskDetail, TaskPriority, TaskStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Avatar } from './avatar';
import { OverlayPortal } from './overlay-portal';
import { STATUS_LABELS, STATUS_DOT_COLOR, EMPLOYEE_SETTABLE_STATUSES, PRIORITY_LABELS } from '@/lib/labels';
import { haptic } from '@/lib/telegram';
import { Card } from '@/components/ui/card';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Textarea, Select } from '@/components/ui/field';
import { SegmentedControl } from '@/components/ui/segmented-control';

// История изменений (аудит 10.09.2026, п. 2.3) — та же логика, что в
// apps/web/src/app/tasks/[id]/page.tsx.
const HISTORY_FIELD_LABELS: Record<string, string> = {
  title: 'Название',
  assigneeId: 'Исполнитель',
  priority: 'Приоритет',
  status: 'Статус',
  dueDate: 'Срок',
  description: 'Описание',
  taskProfileId: 'Профиль задачи',
};

export function TaskDetailOverlay({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { user } = useAuth();
  // Стек, а не одиночный id — клик по подзадаче открывает её тут же поверх
  // оверлея (владелец 08.09.2026), без переделки tasks-screen.tsx: назад
  // сначала возвращает к родителю, и только потом закрывает весь оверлей.
  const [stack, setStack] = useState<string[]>([taskId]);
  const currentId = stack[stack.length - 1];
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
      .get<TaskDetail>(`/tasks/${currentId}`)
      .then(setTask)
      .catch(() => setError('Не удалось загрузить задачу'));
  }

  useEffect(load, [currentId]);
  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => {});
  }, []);

  function openSubtask(id: string) {
    setStack((s) => [...s, id]);
  }
  function goBack() {
    if (stack.length > 1) setStack((s) => s.slice(0, -1));
    else onClose();
  }

  async function changeStatus(status: TaskStatus) {
    setBusy(true);
    haptic('medium');
    try {
      const updated = await api.patch<TaskDetail>(`/tasks/${currentId}/status`, { status });
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
      const updated = await api.post<TaskDetail>(`/tasks/${currentId}/comments`, { body: comment });
      setTask(updated);
      setComment('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить комментарий');
    } finally {
      setBusy(false);
    }
  }

  async function addSubtask(e: FormEvent) {
    e.preventDefault();
    if (!subtaskTitle.trim()) return;
    setBusy(true);
    try {
      await api.post('/tasks', {
        title: subtaskTitle.trim(),
        parentTaskId: currentId,
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
    haptic('medium');
    try {
      // null, а не undefined — иначе снять исполнителя/срок было бы
      // невозможно (Prisma игнорирует undefined-поля в update()).
      const updated = await api.patch<TaskDetail>(`/tasks/${currentId}`, {
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
    haptic('light');
    try {
      if (isWatching) await api.delete(`/tasks/${currentId}/watchers/${user?.id}`);
      else await api.post(`/tasks/${currentId}/watchers`);
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
      await api.post(`/tasks/${currentId}/watchers`, { employeeId: addWatcherId });
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
      await api.delete(`/tasks/${currentId}/watchers/${employeeId}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось убрать наблюдателя');
    } finally {
      setBusy(false);
    }
  }

  const isOwner = user?.role === 'OWNER';
  const canChangeStatus = task && (isOwner || task.assignee?.id === user?.id);
  const availableStatuses = isOwner ? (Object.keys(STATUS_LABELS) as TaskStatus[]) : EMPLOYEE_SETTABLE_STATUSES;
  // Тот же круг, что и у общего редактирования (см. TasksService.remove на
  // бэкенде) — кнопка здесь только отражает реальную границу.
  const canDelete = task && (isOwner || task.creator.id === user?.id);
  const isWatching = task?.watchers.some((w) => w.id === user?.id) ?? false;
  const watchableEmployees = employees.filter(
    (e) => e.id !== user?.id && !task?.watchers.some((w) => w.id === e.id),
  );

  function formatHistoryValue(field: string, value: string | null): string {
    if (value === null) return '—';
    if (field === 'assigneeId') return employees.find((e) => e.id === value)?.fullName ?? value;
    if (field === 'priority') return PRIORITY_LABELS[value as TaskPriority] ?? value;
    if (field === 'status') return STATUS_LABELS[value as TaskStatus] ?? value;
    if (field === 'dueDate') return new Date(value).toLocaleDateString('ru-RU');
    return value;
  }

  async function removeTask() {
    if (!task) return;
    if (!window.confirm(`Удалить задачу «${task.title}»? Это действие необратимо.`)) return;
    setBusy(true);
    haptic('medium');
    try {
      await api.delete(`/tasks/${currentId}`);
      // onClose у вызывающей стороны (tasks-screen.tsx) уже перезагружает
      // список — отдельного refresh-колбэка здесь не нужно.
      if (stack.length > 1) setStack((s) => s.slice(0, -1));
      else onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить задачу');
      setBusy(false);
    }
  }

  return (
    <OverlayPortal>
    <div className="overlay">
      <div className="overlay-header">
        <IconButton icon={ArrowLeft} label="Назад" variant="ghost" onClick={goBack} />
        <strong style={{ flex: 1 }}>{task?.title ?? 'Задача'}</strong>
        {canDelete && !editing && <IconButton icon={Pencil} label="Редактировать задачу" variant="ghost" onClick={startEdit} disabled={busy} />}
        {canDelete && (
          <IconButton icon={Trash2} label="Удалить задачу" variant="ghost" onClick={removeTask} disabled={busy} style={{ color: 'var(--danger)' }} />
        )}
      </div>
      <div className="overlay-body">
        {error && <Alert tone="danger">{error}</Alert>}
        {!task && !error && <p className="ds-field-hint">Загрузка…</p>}
        {task && (
          <>
            {task.parentTask && (
              <Button variant="ghost" style={{ marginBottom: 10 }} onClick={() => openSubtask(task.parentTask!.id)}>
                ↳ Подзадача — {task.parentTask.title}
              </Button>
            )}

            {editing ? (
              <form onSubmit={saveEdit} className="ds-card" style={{ marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Field label="Название">
                  <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} required />
                </Field>
                <Field label="Описание">
                  <Textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={3} />
                </Field>
                <Field label="Исполнитель">
                  <Select
                    value={editAssigneeId}
                    onChange={(e) => setEditAssigneeId(e.target.value)}
                    options={[{ value: '', label: 'Не назначен' }, ...employees.map((emp) => ({ value: emp.id, label: emp.fullName }))]}
                  />
                </Field>
                <Field label="Приоритет">
                  <Select
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value as TaskPriority)}
                    options={(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
                  />
                </Field>
                <Field label="Срок">
                  <Input type="date" value={editDueDate} onChange={(e) => setEditDueDate(e.target.value)} />
                </Field>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button type="submit" variant="primary" disabled={busy || !editTitle.trim()} block>
                    Сохранить
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setEditing(false)} disabled={busy} block>
                    Отмена
                  </Button>
                </div>
              </form>
            ) : (
              <div className="task-card-meta" style={{ marginBottom: 14 }}>
                <Badge>{STATUS_LABELS[task.status]}</Badge>
                {task.assignee && <Badge>Исполнитель: {task.assignee.fullName}</Badge>}
                <Badge>Постановщик: {task.creator.fullName}</Badge>
                {task.dueDate && <Badge>Срок: {new Date(task.dueDate).toLocaleDateString('ru-RU')}</Badge>}
              </div>
            )}

            <div className="watchers-row" style={{ marginBottom: 14 }}>
              <Button variant="ghost" size="sm" icon={isWatching ? EyeOff : Eye} onClick={() => toggleWatch(isWatching)} disabled={busy}>
                {isWatching ? 'Не наблюдать' : 'Наблюдать'}
              </Button>
              {task.watchers.length > 0 && (
                <div className="watchers-avatars">
                  {task.watchers.map((w) => (
                    <span key={w.id} className="watcher-chip" title={w.fullName}>
                      <Avatar name={w.fullName} size={18} />
                      {isOwner && (
                        <button
                          type="button"
                          className="watcher-remove"
                          onClick={() => removeWatcher(w.id)}
                          aria-label={`Убрать ${w.fullName}`}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {isOwner && watchableEmployees.length > 0 && (
                <form className="watcher-add-form" onSubmit={addWatcher} style={{ display: 'flex', gap: 6 }}>
                  <Select
                    value={addWatcherId}
                    onChange={(e) => setAddWatcherId(e.target.value)}
                    options={[{ value: '', label: '+ Наблюдатель…' }, ...watchableEmployees.map((e) => ({ value: e.id, label: e.fullName }))]}
                  />
                  <Button type="submit" variant="secondary" size="sm" disabled={!addWatcherId || busy}>
                    +
                  </Button>
                </form>
              )}
            </div>

            {task.description && <p style={{ marginBottom: 14 }}>{task.description}</p>}

            {(task.sourceMeeting || task.sourceContext) && (
              <Card title="Источник">
                {task.sourceMeeting && (
                  <p className="ds-field-hint">
                    {task.sourceMeeting.title} ·{' '}
                    {new Date(task.sourceMeeting.meetingDate).toLocaleDateString('ru-RU')}
                  </p>
                )}
                {task.sourceContext && <p>{task.sourceContext}</p>}
              </Card>
            )}

            <Card title="Статус">
              {canChangeStatus ? (
                <SegmentedControl
                  options={availableStatuses.map((status) => ({ value: status, label: STATUS_LABELS[status], disabled: busy }))}
                  value={task.status}
                  onChange={(v) => changeStatus(v as TaskStatus)}
                />
              ) : (
                <p className="ds-field-hint">Статус меняет исполнитель задачи или руководитель.</p>
              )}
            </Card>

            <Card title="Комментарии">
              {task.comments.length === 0 && <p className="ds-field-hint">Пока нет комментариев.</p>}
              {task.comments.map((c) => (
                <div key={c.id} className="comment-item">
                  <Avatar name={c.author.fullName} size={26} />
                  <div>
                    <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>{c.author.fullName}</div>
                    <p style={{ margin: '2px 0 0' }}>{c.body}</p>
                  </div>
                </div>
              ))}
              <form onSubmit={submitComment} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Комментарий…" />
                <Button type="submit" variant="primary" disabled={busy}>
                  →
                </Button>
              </form>
            </Card>

            {!task.parentTask && (
              <Card title={`Подзадачи${task.subtaskCount > 0 ? ` (${task.subtaskDoneCount}/${task.subtaskCount})` : ''}`}>
                {task.subtasks.length === 0 && <p className="ds-field-hint">Пока нет подзадач.</p>}
                {task.subtasks.map((s) => (
                  <div key={s.id} className="subtask-row" onClick={() => openSubtask(s.id)}>
                    <span className="status-dot-inline" style={{ background: STATUS_DOT_COLOR[s.status] }} />
                    <span className="subtask-title">{s.title}</span>
                    {s.assignee && <Avatar name={s.assignee.fullName} size={18} />}
                  </div>
                ))}
                <form className="subtask-add-form" onSubmit={addSubtask} style={{ flexWrap: 'wrap', display: 'flex', gap: 6 }}>
                  <Input
                    type="text"
                    value={subtaskTitle}
                    onChange={(e) => setSubtaskTitle(e.target.value)}
                    placeholder="+ Добавить подзадачу…"
                    style={{ flex: '1 1 100%' }}
                  />
                  <Select
                    value={subtaskAssigneeId}
                    onChange={(e) => setSubtaskAssigneeId(e.target.value)}
                    style={{ flex: 1 }}
                    options={[{ value: '', label: 'Без исполнителя' }, ...employees.map((emp) => ({ value: emp.id, label: emp.fullName }))]}
                  />
                  <Button type="submit" variant="secondary" disabled={!subtaskTitle.trim() || busy}>
                    +
                  </Button>
                </form>
              </Card>
            )}

            <Card title="История изменений">
              {task.history.length === 0 && <p className="ds-field-hint">Пока нет изменений.</p>}
              {task.history.map((h) => (
                <div key={h.id} style={{ marginBottom: 8 }}>
                  <div className="ds-field-hint" style={{ fontSize: '0.8em' }}>
                    {h.changedBy?.fullName ?? 'Система'} · {new Date(h.createdAt).toLocaleString('ru-RU')}
                  </div>
                  <div>
                    {HISTORY_FIELD_LABELS[h.field] ?? h.field}: {formatHistoryValue(h.field, h.oldValue)} →{' '}
                    {formatHistoryValue(h.field, h.newValue)}
                  </div>
                </div>
              ))}
            </Card>
          </>
        )}
      </div>
    </div>
    </OverlayPortal>
  );
}

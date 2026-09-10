'use client';

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ListChecks } from 'lucide-react';
import type { TaskListItem, TaskStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Avatar } from '@/components/avatar';
import {
  BOARD_COLUMNS,
  BOARD_SIDE_COLUMNS,
  EMPLOYEE_SETTABLE_STATUSES,
  PRIORITY_CLASS,
  PRIORITY_LABELS,
  STATUS_DOT_COLOR,
  STATUS_LABELS,
} from '@/lib/labels';

function isOverdue(task: TaskListItem): boolean {
  if (!task.dueDate) return false;
  if (task.status === 'DONE' || task.status === 'CANCELLED') return false;
  return new Date(task.dueDate) < new Date();
}

function TaskCard({
  task,
  draggable,
  isDropTarget,
  onDragStart,
  onDragEnd,
  onCardDragOver,
  onCardDrop,
}: {
  task: TaskListItem;
  draggable: boolean;
  isDropTarget: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onCardDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onCardDrop: (e: DragEvent<HTMLDivElement>) => void;
}) {
  const router = useRouter();

  return (
    <div
      className={`kanban-card ${PRIORITY_CLASS[task.priority]} ${isDropTarget ? 'kanban-card-drop-target' : ''}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onCardDragOver}
      onDrop={onCardDrop}
      onClick={() => router.push(`/tasks/${task.id}`)}
      role="button"
      tabIndex={0}
    >
      <p className="kanban-card-title">{task.title}</p>
      {task.dueDate && (
        <div className="kanban-card-meta">
          <span className={`chip ${isOverdue(task) ? 'chip-danger' : ''}`}>
            {new Date(task.dueDate).toLocaleDateString('ru-RU')}
          </span>
        </div>
      )}
      <div className="kanban-card-footer">
        <div className="kanban-card-footer-left">
          <span className="kanban-card-priority-label">{PRIORITY_LABELS[task.priority]}</span>
          {task.subtaskCount > 0 && (
            <span className="kanban-card-subtasks">
              <ListChecks size={13} strokeWidth={2.2} />
              {task.subtaskDoneCount}/{task.subtaskCount}
            </span>
          )}
        </div>
        {task.assignee && <Avatar name={task.assignee.fullName} size={22} />}
      </div>
    </div>
  );
}

export function KanbanBoard() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<TaskListItem[]>('/tasks')
      .then(setTasks)
      .catch(() => setError('Не удалось загрузить задачи'));
  }, []);

  const draggedTask = useMemo(
    () => tasks?.find((t) => t.id === draggedId) ?? null,
    [tasks, draggedId],
  );

  // Раздел 5/10 ТЗ (скорректировано 28.08.2026): постановщик теперь тоже
  // видит задачу на доске, но менять статус может только исполнитель или
  // руководитель — постановщик сам по себе такого права не получает.
  function canManageStatus(task: TaskListItem): boolean {
    return user?.role === 'OWNER' || task.assignee?.id === user?.id;
  }

  function canDropOn(status: TaskStatus): boolean {
    if (!draggedTask) return false;
    if (status === draggedTask.status) return true;
    if (!canManageStatus(draggedTask)) return false;
    if (user?.role === 'OWNER') return true;
    return EMPLOYEE_SETTABLE_STATUSES.includes(status);
  }

  async function moveTask(taskId: string, status: TaskStatus) {
    const task = tasks?.find((t) => t.id === taskId);
    if (!task || task.status === status) return;

    const previousStatus = task.status;
    setTasks((prev) => prev!.map((t) => (t.id === taskId ? { ...t, status } : t)));

    try {
      await api.patch(`/tasks/${taskId}/status`, { status });
    } catch (err) {
      setTasks((prev) => prev!.map((t) => (t.id === taskId ? { ...t, status: previousStatus } : t)));
      setError(err instanceof ApiError ? err.message : 'Не удалось изменить статус');
    }
  }

  // Перестановка внутри одной колонки (владелец 08.09.2026) — не пара
  // соседей, а вся новая последовательность этой колонки: устойчиво к
  // тому, что order у ещё не тронутых задач совпадает (default 0), см.
  // комментарий у TasksService.reorder на бэкенде.
  async function reorderColumn(status: TaskStatus, draggedTaskId: string, targetTaskId: string) {
    const columnTasks = byStatus(status);
    const fromIndex = columnTasks.findIndex((t) => t.id === draggedTaskId);
    const toIndex = columnTasks.findIndex((t) => t.id === targetTaskId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

    const reordered = [...columnTasks];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const orderedIds = reordered.map((t) => t.id);

    // Оптимистично переставляем именно эти id внутри общего массива tasks,
    // не трогая относительный порядок остальных колонок.
    setTasks((prev) => {
      if (!prev) return prev;
      const idSet = new Set(orderedIds);
      const byId = new Map(prev.map((t) => [t.id, t]));
      const firstIdx = prev.findIndex((t) => idSet.has(t.id));
      if (firstIdx === -1) return prev;
      const before = prev.slice(0, firstIdx);
      const after = prev.slice(firstIdx).filter((t) => !idSet.has(t.id));
      const reorderedColumn = orderedIds.map((id) => byId.get(id)!);
      return [...before, ...reorderedColumn, ...after];
    });

    try {
      await api.patch('/tasks/reorder', { taskIds: orderedIds });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось переставить задачу');
      // Откат — проще перезагрузить с сервера, чем распутывать частичный
      // оптимистичный сдвиг обратно вручную.
      api.get<TaskListItem[]>('/tasks').then(setTasks).catch(() => {});
    }
  }

  if (error && !tasks) return <p className="error">{error}</p>;
  if (!tasks) return <p className="hint">Загрузка…</p>;

  const byStatus = (status: TaskStatus) => tasks.filter((t) => t.status === status);

  const renderColumn = (status: TaskStatus) => {
    const columnTasks = byStatus(status);
    const dropAllowed = draggedTask ? canDropOn(status) : true;

    return (
      <div
        key={status}
        className={`kanban-column ${dragOverStatus === status && dropAllowed ? 'kanban-column-drag-over' : ''}`}
        onDragOver={(e) => {
          if (!dropAllowed) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOverStatus(status);
        }}
        onDragLeave={() => setDragOverStatus((s) => (s === status ? null : s))}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverStatus(null);
          setDragOverCardId(null);
          if (!dropAllowed || !draggedId) return;
          moveTask(draggedId, status);
        }}
      >
        <div className="kanban-column-header">
          <span className="kanban-column-dot" style={{ background: STATUS_DOT_COLOR[status] }} />
          <span className="col-name">{STATUS_LABELS[status]}</span>
          <span className="kanban-column-count">{columnTasks.length}</span>
        </div>
        <div className="kanban-column-body">
          {columnTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              draggable={canManageStatus(task)}
              isDropTarget={dragOverCardId === task.id}
              onDragStart={(e) => {
                setDraggedId(task.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDragOverStatus(null);
                setDragOverCardId(null);
              }}
              onCardDragOver={(e) => {
                // Своя колонка — это перестановка (не смена статуса):
                // перехватываем здесь, дальше не всплывает к колонке.
                if (draggedTask && draggedTask.status === task.status && draggedTask.id !== task.id) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverCardId(task.id);
                }
              }}
              onCardDrop={(e) => {
                if (draggedTask && draggedTask.status === task.status && draggedTask.id !== task.id) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragOverCardId(null);
                  reorderColumn(task.status, draggedTask.id, task.id);
                }
              }}
            />
          ))}
          {columnTasks.length === 0 && <p className="kanban-empty">Пусто</p>}
        </div>
      </div>
    );
  };

  return (
    <div>
      {error && <p className="error">{error}</p>}

      <div className="board-scroll">
        <div className="board">
          {BOARD_COLUMNS.map(renderColumn)}
          <div className="board-side-divider" />
          {BOARD_SIDE_COLUMNS.map(renderColumn)}
        </div>
      </div>
    </div>
  );
}

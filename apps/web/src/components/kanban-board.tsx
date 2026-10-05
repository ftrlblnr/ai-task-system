'use client';

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { TaskListItem, TaskStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Alert, KanbanColumn, SearchInput, Select } from '@/components/ui';
import { TaskCard } from '@/components/task-card';
import { BOARD_COLUMNS, BOARD_SIDE_COLUMNS, EMPLOYEE_SETTABLE_STATUSES } from '@/lib/labels';

export function KanbanBoard() {
  const router = useRouter();
  const { user } = useAuth();
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);
  // Поиск/фильтр (аудит 10.09.2026, п. 4.2): раньше в списке задач не было
  // вообще никакого способа найти нужную, кроме скролла — с сотней задач
  // это ломается быстрее всего остального в приложении.
  const [searchQuery, setSearchQuery] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  // Фильтр по направлению (владелец 30.09.2026) — тот же принцип, что
  // assigneeFilter: из уже загруженных задач, без отдельного запроса.
  const [directionFilter, setDirectionFilter] = useState('');

  useEffect(() => {
    api
      .get<TaskListItem[]>('/tasks')
      .then(setTasks)
      .catch(() => setError('Не удалось загрузить задачи'));
  }, []);

  // Список исполнителей для фильтра — из уже загруженных задач, без
  // отдельного запроса к /employees (доска и так знает всех, кто назначен
  // хоть на одну задачу).
  const assigneeOptions = useMemo(() => {
    if (!tasks) return [];
    const byId = new Map<string, string>();
    for (const t of tasks) if (t.assignee) byId.set(t.assignee.id, t.assignee.fullName);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  }, [tasks]);

  const directionOptions = useMemo(() => {
    if (!tasks) return [];
    const byId = new Map<string, string>();
    for (const t of tasks) if (t.assignee?.direction) byId.set(t.assignee.direction.id, t.assignee.direction.title);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  }, [tasks]);

  // Фильтруем ДО построения колонок/drag-состояния — доска целиком (поиск
  // по названию/имени исполнителя, счётчики в шапках колонок, drag-and-drop
  // reorder) работает уже с видимым подмножеством, не с полным списком.
  const visibleTasks = useMemo(() => {
    if (!tasks) return null;
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (assigneeFilter && t.assignee?.id !== assigneeFilter) return false;
      if (directionFilter && t.assignee?.direction?.id !== directionFilter) return false;
      if (!q) return true;
      return t.title.toLowerCase().includes(q) || (t.assignee?.fullName.toLowerCase().includes(q) ?? false);
    });
  }, [tasks, searchQuery, assigneeFilter, directionFilter]);

  const draggedTask = useMemo(
    () => visibleTasks?.find((t) => t.id === draggedId) ?? null,
    [visibleTasks, draggedId],
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

  if (error && !tasks) return <Alert tone="danger">{error}</Alert>;
  if (!tasks || !visibleTasks) return <p className="ds-field-hint">Загрузка…</p>;

  const byStatus = (status: TaskStatus) => visibleTasks.filter((t) => t.status === status);

  const renderColumn = (status: TaskStatus) => {
    const columnTasks = byStatus(status);
    const dropAllowed = draggedTask ? canDropOn(status) : true;

    return (
      <KanbanColumn
        key={status}
        status={status}
        count={columnTasks.length}
        over={dragOverStatus === status && dropAllowed}
        isEmpty={columnTasks.length === 0}
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
        {columnTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            draggable={canManageStatus(task)}
            dropBefore={dragOverCardId === task.id}
            onClick={() => router.push(`/tasks/${task.id}`)}
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
      </KanbanColumn>
    );
  };

  return (
    <div>
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="board-filters">
        <SearchInput value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Поиск по названию или исполнителю…" />
        {assigneeOptions.length > 0 && (
          <Select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            options={[{ value: '', label: 'Все исполнители' }, ...assigneeOptions.map(([id, fullName]) => ({ value: id, label: fullName }))]}
          />
        )}
        {directionOptions.length > 0 && (
          <Select
            value={directionFilter}
            onChange={(e) => setDirectionFilter(e.target.value)}
            options={[{ value: '', label: 'Все направления' }, ...directionOptions.map(([id, title]) => ({ value: id, label: title }))]}
          />
        )}
      </div>

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

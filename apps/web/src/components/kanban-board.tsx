'use client';

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { TaskListItem, TaskStatus } from '@ai-task-system/shared-types';
import { isManagerRole } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { KanbanColumn } from '@/components/ui';
import { TaskCard } from '@/components/task-card';
import { BOARD_COLUMNS, BOARD_SIDE_COLUMNS, EMPLOYEE_SETTABLE_STATUSES } from '@/lib/labels';

interface KanbanBoardProps {
  // Уже отфильтрованные задачи (фильтры и поиск — у страницы, W3).
  tasks: TaskListItem[];
  setTasks: Dispatch<SetStateAction<TaskListItem[] | null>>;
  selectedId: string | null;
  onOpen: (taskId: string) => void;
  onMove: (taskId: string, status: TaskStatus) => void;
  onError: (message: string) => void;
  onReload: () => void;
}

export function KanbanBoard({ tasks: visibleTasks, setTasks, selectedId, onOpen, onMove, onError, onReload }: KanbanBoardProps) {
  const { user } = useAuth();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);

  const draggedTask = useMemo(
    () => visibleTasks?.find((t) => t.id === draggedId) ?? null,
    [visibleTasks, draggedId],
  );

  // Раздел 5/10 ТЗ (скорректировано 28.08.2026): постановщик теперь тоже
  // видит задачу на доске, но менять статус может только исполнитель или
  // руководитель — постановщик сам по себе такого права не получает.
  function canManageStatus(task: TaskListItem): boolean {
    return isManagerRole(user?.role) || task.assignee?.id === user?.id;
  }

  function canDropOn(status: TaskStatus): boolean {
    if (!draggedTask) return false;
    if (status === draggedTask.status) return true;
    if (!canManageStatus(draggedTask)) return false;
    if (isManagerRole(user?.role)) return true;
    return EMPLOYEE_SETTABLE_STATUSES.includes(status);
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
      onError(err instanceof ApiError ? err.message : 'Не удалось переставить задачу');
      // Откат — проще перезагрузить с сервера, чем распутывать частичный
      // оптимистичный сдвиг обратно вручную.
      onReload();
    }
  }

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
          onMove(draggedId, status);
        }}
      >
        {columnTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            draggable={canManageStatus(task)}
            dropBefore={dragOverCardId === task.id}
            selected={task.id === selectedId}
            onClick={() => onOpen(task.id)}
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
    <div className="board-scroll">
      <div className="board">
        {BOARD_COLUMNS.map(renderColumn)}
        <div className="board-side-divider" />
        {BOARD_SIDE_COLUMNS.map(renderColumn)}
      </div>
    </div>
  );
}

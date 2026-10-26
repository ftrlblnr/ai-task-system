'use client';

import { useEffect, useState } from 'react';
import type { TaskDetail, TaskListItem, TaskStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';

// Все задачи для списка и канбана (редизайн web W3) — один запрос, фильтры
// и поиск на клиенте, как и раньше на доске.
export function useTaskList() {
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    api
      .get<TaskListItem[]>('/tasks')
      .then(setTasks)
      .catch(() => setError('Не удалось загрузить задачи'));
  }

  useEffect(reload, []);

  // Оптимистично, с откатом при отказе сервера.
  async function setStatus(taskId: string, status: TaskStatus) {
    const task = tasks?.find((t) => t.id === taskId);
    if (!task || task.status === status) return;
    const previous = task.status;
    setTasks((prev) => prev?.map((t) => (t.id === taskId ? { ...t, status, isOverdue: status === 'DONE' || status === 'CANCELLED' ? false : t.isOverdue } : t)) ?? prev);
    try {
      const updated = await api.patch<TaskDetail>(`/tasks/${taskId}/status`, { status });
      syncFromDetail(updated);
    } catch (err) {
      setTasks((prev) => prev?.map((t) => (t.id === taskId ? { ...t, status: previous } : t)) ?? prev);
      setError(err instanceof ApiError ? err.message : 'Не удалось изменить статус');
    }
  }

  // Боковая карточка изменила задачу — строка списка следует за ней.
  function syncFromDetail(detail: TaskDetail) {
    setTasks(
      (prev) =>
        prev?.map((t) =>
          t.id === detail.id
            ? { ...t, title: detail.title, status: detail.status, priority: detail.priority, dueDate: detail.dueDate, isOverdue: detail.isOverdue, assignee: detail.assignee }
            : t,
        ) ?? prev,
    );
  }

  return { tasks, setTasks, error, setError, reload, setStatus, syncFromDetail };
}

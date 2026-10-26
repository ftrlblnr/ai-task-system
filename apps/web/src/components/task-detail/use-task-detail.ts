'use client';

import { useEffect, useState } from 'react';
import type { EmployeeSummary, Role, TaskDetail, TaskPriority, TaskStatus } from '@ai-task-system/shared-types';
import { isManagerRole } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { STATUS_LABELS, EMPLOYEE_SETTABLE_STATUSES } from '@/lib/labels';

// Данные и действия карточки задачи. Вынесено из app/tasks/[id]/page.tsx
// (редизайн web W0) без изменения поведения — общий код страницы задачи и
// боковой карточки в списке задач (W3).

export interface TaskEditFields {
  title: string;
  description: string;
  assigneeId: string;
  priority: TaskPriority;
  dueDate: string;
}

export function useTaskDetail(id: string) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);

  function load() {
    api
      .get<TaskDetail>(`/tasks/${id}`)
      .then(setTask)
      .catch(() => setError('Не удалось загрузить задачу — возможно, у вас нет к ней доступа'));
  }

  useEffect(load, [id]);
  // Список сотрудников — для форм «исполнитель», «добавить наблюдателя» и
  // для подписей в истории.
  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => {});
  }, []);

  // Общая обёртка действий: busy на время запроса, ошибка — в баннер.
  async function mutate(action: () => Promise<void>, failure: string): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const changeStatus = (status: TaskStatus) =>
    mutate(async () => setTask(await api.patch<TaskDetail>(`/tasks/${id}/status`, { status })), 'Не удалось изменить статус');

  const addComment = (body: string) =>
    mutate(async () => setTask(await api.post<TaskDetail>(`/tasks/${id}/comments`, { body })), 'Не удалось добавить комментарий');

  const remove = () => mutate(() => api.delete(`/tasks/${id}`), 'Не удалось удалить задачу');

  // Подзадача — обычная задача с parentTaskId (владелец 08.09.2026, по
  // образцу Linear/Asana), создаётся прямо из карточки родителя, без
  // отдельной формы/страницы.
  const addSubtask = (title: string, assigneeId: string) =>
    mutate(async () => {
      await api.post('/tasks', { title, parentTaskId: id, assigneeId: assigneeId || undefined });
      load();
    }, 'Не удалось добавить подзадачу');

  // Владелец 08.09.2026: редактирование задачи было в API (PATCH /tasks/:id),
  // но нигде не было формы для него на фронте.
  const saveEdit = (fields: TaskEditFields) =>
    mutate(async () => {
      // null, а не undefined, для assigneeId/dueDate — иначе снять
      // исполнителя/срок через редактирование было бы невозможно:
      // Prisma игнорирует undefined-поля в update(), а не обнуляет их.
      const updated = await api.patch<TaskDetail>(`/tasks/${id}`, {
        title: fields.title,
        description: fields.description || undefined,
        assigneeId: fields.assigneeId || null,
        priority: fields.priority,
        dueDate: fields.dueDate ? new Date(fields.dueDate).toISOString() : null,
      });
      setTask(updated);
    }, 'Не удалось сохранить изменения');

  const toggleWatch = (isWatching: boolean, userId: string | undefined) =>
    mutate(async () => {
      if (isWatching) await api.delete(`/tasks/${id}/watchers/${userId}`);
      else await api.post(`/tasks/${id}/watchers`);
      load();
    }, 'Не удалось изменить наблюдение');

  const addWatcher = (employeeId: string) =>
    mutate(async () => {
      await api.post(`/tasks/${id}/watchers`, { employeeId });
      load();
    }, 'Не удалось добавить наблюдателя');

  const removeWatcher = (employeeId: string) =>
    mutate(async () => {
      await api.delete(`/tasks/${id}/watchers/${employeeId}`);
      load();
    }, 'Не удалось убрать наблюдателя');

  // «Напомнить исполнителю» (W3): ключ один на попытку — повтор той же
  // попытки не пришлёт второе сообщение; после ответа 4xx/успеха ключ
  // сбрасывается (см. useIdempotencyKey).
  const remind = (idem: { key: () => string; reset: () => void }) =>
    mutate(async () => {
      try {
        setTask(await api.post<TaskDetail>(`/tasks/${id}/remind`, undefined, { 'Idempotency-Key': idem.key() }));
        idem.reset();
      } catch (err) {
        if (err instanceof ApiError && err.status < 500) idem.reset();
        throw err;
      }
    }, 'Не удалось отправить напоминание');

  return { task, error, busy, employees, changeStatus, remind, addComment, remove, addSubtask, saveEdit, toggleWatch, addWatcher, removeWatcher };
}

// Кто что может с задачей — только для показа кнопок; реальная граница —
// проверки TasksService на сервере.
export function taskPermissions(task: TaskDetail, user: { id: string; role: Role } | null | undefined) {
  const isManager = isManagerRole(user?.role);
  return {
    isManager,
    // Раздел 5/10 ТЗ (скорректировано 28.08.2026): видеть задачу может и
    // постановщик, но менять статус — только исполнитель или руководитель.
    canChangeStatus: isManager || task.assignee?.id === user?.id,
    availableStatuses: isManager ? (Object.keys(STATUS_LABELS) as TaskStatus[]) : EMPLOYEE_SETTABLE_STATUSES,
    // Удалить может тот же круг, что и редактировать (см. TasksService.remove
    // на бэкенде — это реальная граница, кнопка здесь просто её отражает).
    canDelete: isManager || task.creator.id === user?.id,
    isWatching: task.watchers.some((w) => w.id === user?.id),
  };
}

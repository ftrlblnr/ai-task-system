'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import type { TaskListItem } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { EmptyState, ScreenHeader, SearchInput } from '@/components/ui';
import { TaskCard } from './task-card';
import { TaskDetailOverlay } from './task-detail-overlay';
import { TaskCreateOverlay } from './task-create-overlay';
import { STATUS_LABELS, TASK_SECTIONS, STATUS_DOT_COLOR } from '@/lib/labels';

export function TasksScreen({ active = true }: { active?: boolean }) {
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Поиск (аудит 10.09.2026, п. 4.2) — раньше найти задачу можно было
  // только скроллом, при сотне задач это ломается быстрее всего остального.
  const [searchQuery, setSearchQuery] = useState('');

  function load() {
    api
      .get<TaskListItem[]>('/tasks')
      .then(setTasks)
      .catch(() => setError('Не удалось загрузить задачи'));
  }

  // active приходит от AppShell (владелец 10.09.2026) — экран остаётся
  // смонтированным (см. app-shell.tsx), но данные грузим при каждом возвращении
  // на вкладку, а не один раз за сессию: иначе задача, созданная/изменённая
  // голосом на соседней вкладке, не появится здесь без перезапуска Mini App.
  useEffect(() => {
    if (active) load();
  }, [active]);

  const filteredTasks = tasks
    ? (() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return tasks;
        return tasks.filter(
          (t) => t.title.toLowerCase().includes(q) || (t.assignee?.fullName.toLowerCase().includes(q) ?? false),
        );
      })()
    : null;

  const sections = filteredTasks
    ? TASK_SECTIONS.map((status) => ({
        status,
        items: filteredTasks.filter((t) => t.status === status),
      })).filter((s) => s.items.length > 0)
    : [];

  return (
    <div>
      <ScreenHeader
        title="Задачи"
        action={
          <button type="button" className="screen-header-add" onClick={() => setCreating(true)} aria-label="Новая задача">
            <Plus size={22} strokeWidth={2.25} />
          </button>
        }
      />

      {tasks && tasks.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <SearchInput value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Поиск по задачам…" />
        </div>
      )}

      {error && <p className="ds-field-error">{error}</p>}
      {!tasks && !error && <p className="ds-field-hint">Загрузка…</p>}

      {tasks && tasks.length === 0 && <EmptyState title="Задач пока нет" />}

      {filteredTasks && tasks && tasks.length > 0 && filteredTasks.length === 0 && (
        <p className="ds-field-hint" style={{ marginTop: 8 }}>
          Ничего не найдено по запросу «{searchQuery}».
        </p>
      )}

      {sections.map(({ status, items }) => (
        <div key={status} className="task-section">
          <div className="task-section-title">
            <span className="status-dot" style={{ background: STATUS_DOT_COLOR[status] }} />
            {STATUS_LABELS[status]} · {items.length}
          </div>
          {items.map((task) => (
            <TaskCard key={task.id} task={task} onClick={() => setSelectedId(task.id)} />
          ))}
        </div>
      ))}

      {selectedId && (
        <TaskDetailOverlay
          taskId={selectedId}
          onClose={() => {
            setSelectedId(null);
            load();
          }}
        />
      )}

      {creating && <TaskCreateOverlay onClose={() => setCreating(false)} onCreated={load} />}
    </div>
  );
}

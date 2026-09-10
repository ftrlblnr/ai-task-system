'use client';

import { useEffect, useState } from 'react';
import { ListChecks, Plus, Search } from 'lucide-react';
import type { TaskListItem } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { Avatar } from './avatar';
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

  // active приходит от SwipeShell (владелец 10.09.2026) — экран смонтирован
  // всегда (см. swipe-shell.tsx), но данные грузим при каждом возвращении
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 4px' }}>
        <h1>Задачи</h1>
        <button
          onClick={() => setCreating(true)}
          aria-label="Новая задача"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: 'var(--accent)',
            color: 'var(--accent-contrast)',
          }}
        >
          <Plus size={18} strokeWidth={2.5} />
        </button>
      </div>

      {tasks && tasks.length > 0 && (
        <div className="mobile-search">
          <Search size={15} strokeWidth={2} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск по задачам…"
          />
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {!tasks && !error && <p className="hint">Загрузка…</p>}

      {tasks && tasks.length === 0 && (
        <div className="empty-state">
          <strong>Задач пока нет</strong>
        </div>
      )}

      {filteredTasks && tasks && tasks.length > 0 && filteredTasks.length === 0 && (
        <p className="hint" style={{ marginTop: 8 }}>
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
            <button key={task.id} className="task-card" onClick={() => setSelectedId(task.id)} style={{ width: '100%', textAlign: 'left' }}>
              <span className="task-card-title">{task.title}</span>
              <span className="task-card-meta">
                {task.assignee && (
                  <>
                    <Avatar name={task.assignee.fullName} size={18} />
                    <span className="hint">{task.assignee.fullName}</span>
                  </>
                )}
                {task.dueDate && (
                  <span className={`badge ${task.isOverdue ? 'badge-danger' : 'badge-muted'}`}>
                    {new Date(task.dueDate).toLocaleDateString('ru-RU')}
                  </span>
                )}
                {task.subtaskCount > 0 && (
                  <span className="hint mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <ListChecks size={12} strokeWidth={2.2} />
                    {task.subtaskDoneCount}/{task.subtaskCount}
                  </span>
                )}
              </span>
            </button>
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

'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { isManagerRole, type TaskListItem, type TaskStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { companyDayKey } from '@/lib/company-time';
import { STATUS_LABELS } from '@/lib/labels';
import { notificationHaptic } from '@/lib/telegram';
import { Alert, EmptyState, ScreenHeader, SearchInput, Skeleton, cx, useAppToast } from '@/components/ui';
import { useSectionIntent } from './app-shell';
import { TaskCard } from './task-card';
import { TaskDetailOverlay } from './task-detail-overlay';
import { TaskCreateOverlay } from './task-create-overlay';

// «Задачи» (редизайн M3, MINIAPP_REDESIGN.md §4.3): чипы-фильтры со
// счётчиками вместо групп по статусам — статус теперь на карточке. Всё
// считается на клиенте из одного GET /tasks (сервер уже отдаёт только то,
// что пользователю видно).

type Filter = 'all' | 'mine' | 'created' | 'today' | 'overdue';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'mine', label: 'Мои' },
  { key: 'created', label: 'Поставил я' },
  { key: 'today', label: 'Сегодня' },
  { key: 'overdue', label: 'Просрочено' },
];
const CLOSED = new Set<TaskStatus>(['DONE', 'CANCELLED']);

function matches(task: TaskListItem, filter: Filter, userId: string, todayKey: string): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'mine':
      return task.assignee?.id === userId;
    case 'created':
      return task.creator.id === userId;
    case 'today':
      return !CLOSED.has(task.status) && !!task.dueDate && companyDayKey(task.dueDate) === todayKey;
    case 'overdue':
      // Просрочка — вычисляемый признак, не статус (TaskListItem.isOverdue).
      return task.isOverdue;
  }
}

// Следующий шаг по чекбоксу. Права — как у PATCH /tasks/:id/status
// (TasksService.updateStatus): статус меняет исполнитель или руководитель,
// сотруднику доступны только рабочие статусы. Проверка на сервере всё
// равно окончательная — здесь только не показываем заведомо запрещённое.
export function nextTaskStatus(task: TaskListItem, userId: string, manager: boolean): TaskStatus | null {
  if (!manager && task.assignee?.id !== userId) return null;
  switch (task.status) {
    case 'NEW':
    case 'RETURNED':
      return 'IN_PROGRESS';
    case 'IN_PROGRESS':
      // Свою же задачу проверять некому — сразу «Выполнена».
      return task.creator.id === userId ? 'DONE' : 'IN_REVIEW';
    case 'IN_REVIEW':
      // Принимает работу руководитель; исполнитель ждёт проверки.
      return manager ? 'DONE' : null;
    default:
      // Черновик подтверждают в карточке, закрытые — уже закрыты.
      return null;
  }
}

// Сверху — открытые: сначала просроченные, затем по сроку, без срока в
// конце; закрытые — внизу.
function byUrgency(a: TaskListItem, b: TaskListItem): number {
  const closed = Number(CLOSED.has(a.status)) - Number(CLOSED.has(b.status));
  if (closed) return closed;
  const overdue = Number(b.isOverdue) - Number(a.isOverdue);
  if (overdue) return overdue;
  const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
  const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
  if (ad !== bd) return ad - bd;
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}

export function TasksScreen({ active = true }: { active?: boolean }) {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, showToast] = useAppToast();
  // Поиск (аудит 10.09.2026, п. 4.2) — при сотне задач скролла мало.
  const [searchQuery, setSearchQuery] = useState('');
  const [intent, consumeIntent] = useSectionIntent('tasks');

  function load() {
    api
      .get<TaskListItem[]>('/tasks')
      .then((t) => {
        setTasks(t);
        setError(null);
      })
      .catch(() => setError('Не удалось загрузить задачи'));
  }

  // active приходит от AppShell (владелец 10.09.2026) — экран остаётся
  // смонтированным (см. app-shell.tsx), но данные грузим при каждом возвращении
  // на вкладку, а не один раз за сессию: иначе задача, созданная/изменённая
  // голосом на соседней вкладке, не появится здесь без перезапуска Mini App.
  useEffect(() => {
    if (active) load();
  }, [active]);

  // «Просрочено» на «Сегодня» открывает раздел сразу с этим фильтром.
  useEffect(() => {
    if (!intent) return;
    if (FILTERS.some((f) => f.key === intent)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- разовый переход из другого раздела
      setFilter(intent as Filter);
      setSearchQuery('');
    }
    consumeIntent();
  }, [intent, consumeIntent]);

  if (!user) return null;
  const manager = isManagerRole(user.role);
  const todayKey = companyDayKey(new Date());

  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.key, (tasks ?? []).filter((t) => matches(t, f.key, user.id, todayKey)).length]),
  ) as Record<Filter, number>;

  const q = searchQuery.trim().toLowerCase();
  const visible = (tasks ?? [])
    .filter((t) => matches(t, filter, user.id, todayKey))
    .filter((t) => !q || t.title.toLowerCase().includes(q) || (t.assignee?.fullName.toLowerCase().includes(q) ?? false))
    .sort(byUrgency);

  async function advance(task: TaskListItem, status: TaskStatus) {
    setBusyId(task.id);
    try {
      await api.patch(`/tasks/${task.id}/status`, { status });
      notificationHaptic('success');
      setTasks((cur) => cur?.map((t) => (t.id === task.id ? { ...t, status, isOverdue: CLOSED.has(status) ? false : t.isOverdue } : t)) ?? cur);
      showToast(STATUS_LABELS[status]);
      load();
    } catch (err) {
      notificationHaptic('error');
      showToast(err instanceof ApiError ? err.message : 'Не удалось изменить статус');
    } finally {
      setBusyId(null);
    }
  }

  const filterLabel = FILTERS.find((f) => f.key === filter)!.label;

  return (
    <div>
      <ScreenHeader
        kicker={tasks ? `${filterLabel} · ${counts[filter]}` : undefined}
        title="Задачи"
        action={
          <button type="button" className="screen-header-add" onClick={() => setCreating(true)} aria-label="Новая задача">
            <Plus size={22} strokeWidth={2.25} />
          </button>
        }
      />

      <div className="filter-chips" role="tablist" aria-label="Фильтр задач">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className={cx('filter-chip', filter === f.key && 'is-active')}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {tasks && <span className="filter-chip-count">{counts[f.key]}</span>}
          </button>
        ))}
      </div>

      {tasks && tasks.length > 0 && (
        <div className="tasks-search">
          <SearchInput value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Поиск по задачам…" aria-label="Поиск по задачам" />
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {!tasks && !error && (
        <div className="task-list">
          {[0, 1, 2].map((i) => (
            <div key={i} className="task-row">
              <Skeleton height={16} width="70%" />
            </div>
          ))}
        </div>
      )}

      {tasks && tasks.length === 0 && <EmptyState title="Задач пока нет" />}

      {tasks && tasks.length > 0 && visible.length === 0 && (
        <div className="attention-empty">{q ? `Ничего не найдено по запросу «${searchQuery.trim()}»` : 'Таких задач нет'}</div>
      )}

      {visible.length > 0 && (
        <div className="task-list">
          {visible.map((task) => {
            const next = nextTaskStatus(task, user.id, manager);
            return (
              <TaskCard
                key={task.id}
                task={task}
                next={next}
                busy={busyId === task.id}
                onAdvance={() => next && void advance(task, next)}
                onOpen={() => setSelectedId(task.id)}
              />
            );
          })}
        </div>
      )}

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
      {toast}
    </div>
  );
}

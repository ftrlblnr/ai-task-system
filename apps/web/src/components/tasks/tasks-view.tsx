'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { TaskListItem } from '@ai-task-system/shared-types';
import { isManagerRole } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { Alert, PageHeader, SearchInput, SegmentedControl, Select, cx } from '@/components/ui';
import { KanbanBoard } from '@/components/kanban-board';
import { useAgentContext, useAgentPanel } from '@/components/agent-panel/agent-context';
import { EXTRA_FILTERS, FILTER_LABELS, TASK_FILTERS, filterCounts, isClosed, matchesFilter, parseFilter, pluralTasks, type TaskFilter } from './task-filters';
import { TaskList } from './task-list';
import { TaskSideCard } from './task-side-card';
import { useTaskList } from './use-task-list';

// Раздел «Задачи» (редизайн web W3, docs/WEB_REDESIGN.md §4.4): быстрые
// фильтры в ?filter=, список или канбан, боковая карточка по ?task=.
// Карточка и панель агента рядом не показываются: при открытой панели
// карточка прячется, но задача остаётся контекстом агента.

type View = 'list' | 'kanban';
const VIEW_KEY = 'tasks.view';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'kanban' ? 'kanban' : 'list';
  } catch {
    return 'list';
  }
}

// Список — по сроку (без срока в конце), затем по дате создания.
function byDue(a: TaskListItem, b: TaskListItem): number {
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate || b.dueDate) return a.dueDate ? -1 : 1;
  return b.createdAt.localeCompare(a.createdAt);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.agent-panel, [role="dialog"]')) return true;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function TasksView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const list = useTaskList();
  const panel = useAgentPanel();

  const filter = parseFilter(searchParams.get('filter'));
  const selectedId = searchParams.get('task');
  const [view, setViewState] = useState<View>(readView);
  // Поиск и фильтры по исполнителю/направлению (аудит 10.09.2026, п. 4.2;
  // владелец 30.09.2026) — из уже загруженных задач, без запросов.
  const [searchQuery, setSearchQuery] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState(() => searchParams.get('assignee') ?? '');
  const [directionFilter, setDirectionFilter] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  const tasks = list.tasks;
  const selectedTask = tasks?.find((t) => t.id === selectedId) ?? null;
  const cardVisible = !!selectedId && !panel.open;

  useAgentContext(
    selectedId
      ? { kind: 'task', id: selectedId, label: selectedTask?.title }
      : { kind: 'list', route: '/tasks', filter: FILTER_LABELS[filter], label: `Задачи · ${FILTER_LABELS[filter]}` },
  );

  function setView(next: View) {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // приватный режим — вид просто не запомнится
    }
  }

  function hrefWith(changes: Record<string, string | null>): string {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    return query ? `/tasks?${query}` : '/tasks';
  }

  // Первое открытие — новая запись истории («назад» закрывает карточку),
  // переход между задачами — без неё.
  function openTask(taskId: string) {
    if (panel.open) panel.setOpen(false);
    if (taskId === selectedId) return;
    const href = hrefWith({ task: taskId });
    if (selectedId) router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  }

  function closeCard() {
    router.replace(hrefWith({ task: null }), { scroll: false });
  }

  function pickFilter(next: TaskFilter) {
    router.replace(hrefWith({ filter: next === 'all' ? null : next }), { scroll: false });
  }

  const assigneeOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const t of tasks ?? []) if (t.assignee) byId.set(t.assignee.id, t.assignee.fullName);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  }, [tasks]);

  const directionOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const t of tasks ?? []) if (t.assignee?.direction) byId.set(t.assignee.direction.id, t.assignee.direction.title);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  }, [tasks]);

  const counts = useMemo(() => filterCounts(tasks ?? [], user?.id), [tasks, user?.id]);

  const visibleTasks = useMemo(() => {
    if (!tasks) return [];
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (!matchesFilter(t, filter, user?.id)) return false;
      if (assigneeFilter && t.assignee?.id !== assigneeFilter) return false;
      if (directionFilter && t.assignee?.direction?.id !== directionFilter) return false;
      if (!q) return true;
      return t.title.toLowerCase().includes(q) || (t.assignee?.fullName.toLowerCase().includes(q) ?? false);
    });
  }, [tasks, filter, user?.id, searchQuery, assigneeFilter, directionFilter]);

  const openRows = useMemo(() => visibleTasks.filter((t) => !isClosed(t)).sort(byDue), [visibleTasks]);
  const closedRows = useMemo(() => visibleTasks.filter(isClosed).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [visibleTasks]);
  const listRows = showClosed ? [...openRows, ...closedRows] : openRows;

  const canToggleDone = (task: TaskListItem) => task.status !== 'CANCELLED' && (isManagerRole(user?.role) || task.assignee?.id === user?.id);
  const toggleDone = (task: TaskListItem) => void list.setStatus(task.id, task.status === 'DONE' ? 'IN_PROGRESS' : 'DONE');

  // Клавиши списка: J/K — следующая/предыдущая, Enter — развернуть,
  // E — выполнено (если можно), Esc — закрыть карточку.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if ((key === 'j' || key === 'k') && view === 'list' && listRows.length > 0) {
        e.preventDefault();
        const idx = listRows.findIndex((t) => t.id === selectedId);
        const next = idx === -1 ? 0 : Math.min(listRows.length - 1, Math.max(0, idx + (key === 'j' ? 1 : -1)));
        openTask(listRows[next].id);
      } else if (key === 'e' && selectedTask && canToggleDone(selectedTask)) {
        e.preventDefault();
        toggleDone(selectedTask);
      } else if (key === 'enter' && selectedId && !(e.target instanceof HTMLElement && e.target.closest('button, a'))) {
        e.preventDefault();
        router.push(`/tasks/${selectedId}`);
      } else if (key === 'escape' && selectedId) {
        closeCard();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Выбранная клавишами строка — в поле зрения.
  useEffect(() => {
    if (selectedId) document.querySelector(`[data-task-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const chipFilters: TaskFilter[] = [...TASK_FILTERS, ...EXTRA_FILTERS.filter((f) => f === filter)];
  const shownCount = view === 'list' ? openRows.length : visibleTasks.length;

  return (
    <div className="tasks-page">
      <PageHeader
        kicker={tasks ? `${FILTER_LABELS[filter]} · ${pluralTasks(shownCount)}` : 'Задачи'}
        title="Задачи"
        actions={
          <>
            <SegmentedControl
              label="Вид"
              value={view}
              onChange={(v) => setView(v as View)}
              options={[
                { value: 'list', label: 'Список' },
                { value: 'kanban', label: 'Канбан' },
              ]}
            />
            {/* Раздел 5 ТЗ (28.08.2026): ставить задачи может любой участник. */}
            <Link href="/tasks/new" className="ds-btn ds-btn-primary">
              <Plus size={18} strokeWidth={1.75} />
              Новая задача
            </Link>
          </>
        }
      />

      {list.error && <Alert tone="danger">{list.error}</Alert>}

      <div className="tasks-toolbar">
        <div className="pill-chips" role="group" aria-label="Фильтр задач">
          {chipFilters.map((f) => (
            <button key={f} type="button" className={cx('pill-chip', f === filter && 'is-active')} aria-pressed={f === filter} onClick={() => pickFilter(f)}>
              {FILTER_LABELS[f]}
              {tasks && <span className="pill-chip-count">{counts[f]}</span>}
            </button>
          ))}
        </div>
        <div className="tasks-toolbar-search">
          <SearchInput value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Поиск по названию или исполнителю…" />
          {assigneeOptions.length > 0 && (
            <Select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              aria-label="Исполнитель"
              options={[{ value: '', label: 'Все исполнители' }, ...assigneeOptions.map(([id, fullName]) => ({ value: id, label: fullName }))]}
            />
          )}
          {directionOptions.length > 0 && (
            <Select
              value={directionFilter}
              onChange={(e) => setDirectionFilter(e.target.value)}
              aria-label="Направление"
              options={[{ value: '', label: 'Все направления' }, ...directionOptions.map(([id, title]) => ({ value: id, label: title }))]}
            />
          )}
        </div>
      </div>

      <div className={cx('tasks-layout', cardVisible && 'has-card')}>
        <div className="tasks-main">
          {!tasks ? (
            !list.error && <p className="ds-field-hint">Загрузка…</p>
          ) : view === 'list' ? (
            <>
              {listRows.length > 0 ? (
                <TaskList tasks={listRows} selectedId={selectedId} canToggleDone={canToggleDone} onOpen={openTask} onToggleDone={toggleDone} />
              ) : (
                <p className="tasks-empty">В этом фильтре открытых задач нет</p>
              )}
              {closedRows.length > 0 && (
                <button type="button" className="tasks-closed-toggle" onClick={() => setShowClosed((v) => !v)}>
                  {showClosed ? 'Скрыть закрытые' : `Показать закрытые · ${closedRows.length}`}
                </button>
              )}
              <p className="tasks-keys">Клавиши: J / K — следующая / предыдущая, E — выполнено, Enter — развернуть, Esc — закрыть, Ctrl K — агент</p>
            </>
          ) : (
            <KanbanBoard
              tasks={visibleTasks}
              setTasks={list.setTasks}
              selectedId={selectedId}
              onOpen={openTask}
              onMove={(taskId, status) => void list.setStatus(taskId, status)}
              onError={list.setError}
              onReload={list.reload}
            />
          )}
        </div>
        {cardVisible && selectedId && (
          <TaskSideCard key={selectedId} taskId={selectedId} onClose={closeCard} onAskAgent={panel.openAndFocus} onChanged={list.syncFromDetail} />
        )}
      </div>
    </div>
  );
}

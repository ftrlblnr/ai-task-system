'use client';

import { useEffect, useState } from 'react';
import type { ReceptionListResponse, ReceptionRequestItem, TaskListItem } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';
import { companyDate, companyDayKey, companyTime } from '@/lib/company-time';
import { Alert, Pill, SectionLabel, Skeleton, StatTile, StatusPill } from '@/components/ui';
import { useOpenSection } from '../app-shell';
import { TaskDetailOverlay } from '../task-detail-overlay';

// «Сегодня» сотрудника (и ADMIN — §4.2): мои задачи на сегодня и просрочки
// из GET /tasks (фильтр на клиенте), мои вопросы в приёмной.

const CLOSED = new Set(['DONE', 'CANCELLED']);

export function EmployeeToday({ active, userId }: { active: boolean; userId: string }) {
  const openSection = useOpenSection();
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [questions, setQuestions] = useState<ReceptionRequestItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);

  function load() {
    api
      .get<TaskListItem[]>('/tasks')
      .then((data) => {
        setTasks(data);
        setError(null);
      })
      .catch(() => setError('Не удалось загрузить задачи'));
    api
      .get<ReceptionListResponse>('/reception/requests/mine?scope=active&limit=20')
      .then((res) => setQuestions(res.items))
      .catch(() => setQuestions([]));
  }

  useEffect(() => {
    if (active) load();
  }, [active]);

  const todayKey = companyDayKey(new Date());
  const mine = (tasks ?? []).filter((t) => t.assignee?.id === userId && !CLOSED.has(t.status));
  const overdue = mine.filter((t) => t.isOverdue);
  const dueToday = mine.filter((t) => !t.isOverdue && t.dueDate && companyDayKey(t.dueDate) === todayKey);
  const inReview = mine.filter((t) => t.status === 'IN_REVIEW');
  // Сначала просроченные, потом сегодняшние — по сроку.
  const list = [...overdue, ...dueToday].sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="stat-grid stat-grid-3">
        {tasks ? (
          <>
            <StatTile value={dueToday.length} label="На сегодня" onClick={() => openSection('tasks', 'today')} />
            <StatTile value={overdue.length} label="Просрочено" accent={overdue.length > 0} onClick={() => openSection('tasks', 'overdue')} />
            <StatTile value={inReview.length} label="На проверке" onClick={() => openSection('tasks')} />
          </>
        ) : (
          [0, 1, 2].map((i) => <Skeleton key={i} height={76} radius={16} />)
        )}
      </div>

      <SectionLabel>Мои задачи на сегодня</SectionLabel>
      {!tasks ? (
        <Skeleton height={52} radius={18} />
      ) : list.length === 0 ? (
        <div className="attention-empty">На сегодня задач нет</div>
      ) : (
        <div className="list-card">
          {list.map((t) => (
            <button key={t.id} type="button" className="list-row today-task" onClick={() => setTaskId(t.id)}>
              <span className="list-row-label">
                <span className="today-task-title">{t.title}</span>
                <span className="today-task-meta">
                  <StatusPill status={t.status} />
                  <span className={t.isOverdue ? 'due is-overdue' : 'due'}>
                    {t.isOverdue ? companyDate(t.dueDate!) : companyTime(t.dueDate!)}
                  </span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {questions.length > 0 && (
        <>
          <SectionLabel>Мои вопросы в приёмной</SectionLabel>
          <div className="list-card">
            {questions.map((q) => (
              <button key={q.id} type="button" className="list-row" onClick={() => openSection('reception')}>
                <span className="list-row-label">{q.title}</span>
                {q.status === 'CALLED' ? <Pill tone="orange">Вас зовут</Pill> : <Pill tone="teal">В очереди</Pill>}
              </button>
            ))}
          </div>
        </>
      )}

      {taskId && (
        <TaskDetailOverlay
          taskId={taskId}
          onClose={() => {
            setTaskId(null);
            load();
          }}
        />
      )}
    </>
  );
}

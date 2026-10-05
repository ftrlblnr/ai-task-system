'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, RefreshCw, Sparkles } from 'lucide-react';
import { AgentHero } from './agent-hero';
import { OverviewStats } from './overview-stats';
import { AttentionTasks } from './attention-tasks';
import { ReceptionPreview } from './reception-preview';
import { UpcomingEvents } from './upcoming-events';
import { useDashboardOverview, isStale, formatFetchedAt } from './use-dashboard-overview';
import { IconButton } from '@/components/ui/button';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026) — раздел 5: порядок блоков
// сверху вниз, верхняя панель ЛОКАЛЬНА этой странице (другие экраны свой
// заголовок не меняют — раздел 3 ТЗ запрещает переработку внутренних
// экранов сверх необходимых переходов).
export function DashboardPage() {
  const router = useRouter();
  const { tasks, reception, calendar, loading, refreshing, allFreshAt, refresh } = useDashboardOverview();

  const sourcesWithFreshness: { label: string; fetchedAt: string | null; error: string | null }[] = [
    { label: 'задач', fetchedAt: tasks.fetchedAt, error: tasks.error },
    { label: 'приёмной', fetchedAt: reception.fetchedAt, error: reception.error },
    { label: 'календаря', fetchedAt: calendar.fetchedAt, error: calendar.error },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <p className="ds-field-hint" style={{ margin: 0 }}>
          Рабочее пространство / Стол руководителя
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="ds-btn ds-btn-ghost ds-btn-sm" onClick={() => router.push('/assistant')}>
            <Sparkles size={14} strokeWidth={1.75} />
            Спросить агента
          </button>
          <Link href="/tasks/new" className="ds-btn ds-btn-primary ds-btn-sm">
            <Plus size={14} strokeWidth={1.75} />
            Новая задача
          </Link>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0 }}>Стол руководителя</h1>
          <p className="ds-field-hint" style={{ margin: '4px 0 0' }}>
            Задачи, вопросы и встречи. Начните с того, что важно сейчас.
          </p>
        </div>
        <IconButton icon={RefreshCw} label="Обновить" variant="outline" onClick={refresh} disabled={refreshing} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <AgentHero />

        <OverviewStats
          active={tasks.data?.counts.active ?? null}
          overdue={tasks.data?.counts.overdue ?? null}
          inReview={tasks.data?.counts.inReview ?? null}
          waitingReception={reception.data?.waitingCount ?? null}
          tasksErrored={Boolean(tasks.error)}
          receptionErrored={Boolean(reception.error)}
        />

        <div className="dashboard-two-col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <AttentionTasks items={tasks.data?.items ?? null} loading={loading && !tasks.data} errored={Boolean(tasks.error)} />
          <ReceptionPreview
            current={reception.data?.current}
            items={reception.data?.items ?? null}
            loading={loading && !reception.data}
            errored={Boolean(reception.error)}
          />
        </div>

        <UpcomingEvents items={calendar.data?.items ?? null} loading={loading && !calendar.data} errored={Boolean(calendar.error)} />

        <p className="ds-field-hint" style={{ margin: 0 }}>
          {allFreshAt ? (
            `Последнее обновление: ${formatFetchedAt(allFreshAt)}`
          ) : (
            sourcesWithFreshness.map((s, i) => (
              <span key={s.label}>
                {i > 0 && ' · '}
                {s.error
                  ? s.fetchedAt
                    ? `Данные ${s.label} на ${formatFetchedAt(s.fetchedAt)}, обновить не удалось`
                    : `Данные ${s.label} недоступны`
                  : s.fetchedAt
                    ? `${s.label}: ${formatFetchedAt(s.fetchedAt)}${isStale(s.fetchedAt) ? ' (устарело)' : ''}`
                    : null}
              </span>
            ))
          )}
        </p>
      </div>
    </div>
  );
}

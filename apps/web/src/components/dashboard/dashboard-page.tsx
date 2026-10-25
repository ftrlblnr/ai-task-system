'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw } from 'lucide-react';
import { OverviewStats } from './overview-stats';
import { AttentionTasks } from './attention-tasks';
import { ReceptionPreview } from './reception-preview';
import { AppsPanel, AskAgent, CalendarPanel, FilesStrip, MailPanel, RoutinesPanel, SkillsPanel, type AppCounts } from './console-panels';
import { useDashboardOverview, isStale, formatFetchedAt } from './use-dashboard-overview';
import { IconButton, StatBar } from '@/components/ui';

// Пульт руководителя (ARMS, фаза 6; было — «Стол руководителя», ТЗ v1.0
// 05.10.2026). Всё на одном экране и без вызова модели: слева приложения и
// календарь, в центре файлы и фокус дня, справа почта, регламенты и навыки,
// в шапке — расход ИИ. На среднем экране левая колонка уходит под правую,
// на телефоне — всё одной колонкой, фокус дня первым.

function usd(value: number): string {
  if (value === 0) return '$0';
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
}

function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1000)} тыс.`;
  return `${(value / 1_000_000).toFixed(1)} млн`;
}

export function DashboardPage() {
  const { tasks, reception, calendar, panels, loading, refreshing, allFreshAt, refresh } = useDashboardOverview();
  const usage = panels.usage.data;
  // Дата — один раз при показе (не в каждом рендере).
  const [today] = useState(() => new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', weekday: 'long', day: 'numeric', month: 'long' }));

  const counts: AppCounts = {
    tasks: tasks.data?.counts.active ?? null,
    reception: reception.data?.waitingCount ?? null,
    mail: panels.mail.data?.connected ? panels.mail.data.needsYou.length : null,
    calendar: calendar.data?.items.length ?? null,
    meetings: panels.apps.data?.meetings7d ?? null,
    trips: panels.apps.data?.trips ?? null,
    memory: panels.apps.data?.memoryPending ?? null,
    skills: panels.skills.data?.total ?? null,
    routines: panels.routines.data?.activeCount ?? null,
    recommendations: panels.apps.data?.recommendations ?? null,
    files: panels.files.data?.total ?? null,
    usage: usage ? usd(usage.today.costUsd) : null,
  };

  const sources: { label: string; fetchedAt: string | null; error: string | null }[] = [
    { label: 'задач', fetchedAt: tasks.fetchedAt, error: tasks.error },
    { label: 'приёмной', fetchedAt: reception.fetchedAt, error: reception.error },
    { label: 'календаря', fetchedAt: calendar.fetchedAt, error: calendar.error },
  ];

  return (
    <div className="console">
      <header className="console-head">
        <div>
          <h1>Стол руководителя</h1>
          <p className="console-muted console-date">{today}</p>
        </div>
        {usage && (
          <Link href="/ai-usage" className="console-usage" title="Расход ИИ">
            <StatBar
              items={[
                { label: 'Сегодня', value: `${usd(usage.today.costUsd)} · ${tokens(usage.today.tokens)} ток.` },
                { label: 'Неделя', value: `${usd(usage.week.costUsd)} · ${tokens(usage.week.tokens)} ток.` },
                { label: 'Кэш', value: usage.week.cacheShare === null ? '—' : `${Math.round(usage.week.cacheShare * 100)}%` },
              ]}
            />
          </Link>
        )}
        <div className="console-head-actions">
          <IconButton icon={RefreshCw} label="Обновить" variant="outline" onClick={refresh} disabled={refreshing} />
          <Link href="/tasks/new" className="ds-btn ds-btn-primary">
            <Plus size={16} strokeWidth={1.75} />
            Новая задача
          </Link>
        </div>
      </header>

      <div className="console-grid">
        <div className="console-col console-center">
          <section className="console-focus" aria-label="Фокус дня">
            <AskAgent skills={panels.skills.data?.all ?? []} />
            <OverviewStats
              active={tasks.data?.counts.active ?? null}
              overdue={tasks.data?.counts.overdue ?? null}
              inReview={tasks.data?.counts.inReview ?? null}
              waitingReception={reception.data?.waitingCount ?? null}
              tasksErrored={Boolean(tasks.error)}
              receptionErrored={Boolean(reception.error)}
            />
          </section>
          <FilesStrip state={panels.files} loading={loading} />
          <AttentionTasks items={tasks.data?.items ?? null} loading={loading && !tasks.data} errored={Boolean(tasks.error)} />
          <ReceptionPreview current={reception.data?.current} items={reception.data?.items ?? null} loading={loading && !reception.data} errored={Boolean(reception.error)} />
        </div>
        <div className="console-col console-right">
          <MailPanel state={panels.mail} loading={loading} />
          <RoutinesPanel state={panels.routines} loading={loading} />
          <SkillsPanel state={panels.skills} loading={loading} />
        </div>
        <div className="console-col console-left">
          <AppsPanel counts={counts} />
          <CalendarPanel state={calendar} loading={loading} />
        </div>
      </div>

      <p className="ds-field-hint console-fresh">
        {allFreshAt
          ? `Обновлено ${formatFetchedAt(allFreshAt)}`
          : sources.map((s, i) => (
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
            ))}
      </p>
    </div>
  );
}

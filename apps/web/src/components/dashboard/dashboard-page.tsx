'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw } from 'lucide-react';
import { FocusSection } from './focus-section';
import { TodaySection } from './today-section';
import { FilesPanel, MailPanel, RoutinesPanel, SkillsPanel } from './console-panels';
import { useDashboardOverview, isStale, formatFetchedAt } from './use-dashboard-overview';
import { IconButton } from '@/components/ui';
import { useAgentContext } from '@/components/agent-panel/agent-context';
import { AgentButton } from '@/components/agent-panel/agent-panel';

// Пульт руководителя (ARMS, фаза 6; раскладка — редизайн web W5,
// docs/WEB_REDESIGN.md §4.3). Всё на одном экране и без вызова модели:
// секции-карточки в сетке auto-fit — фокус дня, сегодня, почта, регламенты,
// навыки, готовые файлы с расходом ИИ. Спросить агента — панель (Ctrl K).

const CLOCK_MS = 60_000;

export function DashboardPage() {
  const { tasks, reception, calendar, panels, loading, refreshing, allFreshAt, refresh } = useDashboardOverview();
  useAgentContext({ kind: 'dashboard' });
  // «Через 25 мин», «ждёт 40 мин» — от этих часов, раз в минуту.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const today = new Date(now).toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', weekday: 'long', day: 'numeric', month: 'long' });

  const sources: { label: string; fetchedAt: string | null; error: string | null }[] = [
    { label: 'задач', fetchedAt: tasks.fetchedAt, error: tasks.error },
    { label: 'приёмной', fetchedAt: reception.fetchedAt, error: reception.error },
    { label: 'календаря', fetchedAt: calendar.fetchedAt, error: calendar.error },
  ];

  return (
    <div className="console">
      <header className="console-head">
        <div>
          <span className="page-kicker">{today}</span>
          <h1>Пульт</h1>
        </div>
        <div className="console-head-actions">
          <IconButton icon={RefreshCw} label="Обновить" variant="outline" onClick={refresh} disabled={refreshing} />
          <AgentButton />
          <Link href="/tasks/new" className="ds-btn ds-btn-primary">
            <Plus size={16} strokeWidth={1.75} />
            Новая задача
          </Link>
        </div>
      </header>

      <div className="pult-grid">
        <FocusSection tasks={tasks} reception={reception} mail={panels.mail} loading={loading} now={now} onChanged={refresh} />
        <TodaySection state={calendar} loading={loading} now={now} />
        <MailPanel state={panels.mail} loading={loading} now={now} />
        <RoutinesPanel state={panels.routines} loading={loading} now={now} />
        <SkillsPanel state={panels.skills} loading={loading} />
        <FilesPanel state={panels.files} usage={panels.usage} loading={loading} now={now} />
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

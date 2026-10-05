'use client';

import Link from 'next/link';
import { Check, Clock, DoorOpen, SquareKanban } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import type { IconComponent } from '@/components/ui/button';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026, раздел 7). Карточка целиком —
// ссылка; ноль показывается только после успешной загрузки (status==='ok'),
// недоступное значение — «—» с пояснением «Нет данных» (status==='error').

interface StatCardProps {
  icon: IconComponent;
  label: string;
  value: number | null;
  hint: string;
  href: string;
  errored: boolean;
}

function StatCard({ icon: Icon, label, value, hint, href, errored }: StatCardProps) {
  return (
    <Link
      href={href}
      className="ds-card ds-focusable"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, textDecoration: 'none', color: 'inherit' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="ds-field-hint">{label}</span>
        <Icon size={16} strokeWidth={1.75} className="ds-field-hint" />
      </div>
      {value === null ? (
        errored ? (
          <span style={{ fontSize: 32, lineHeight: '38px', fontWeight: 650, color: 'var(--ink-3)' }}>—</span>
        ) : (
          <Skeleton width={60} height={38} />
        )
      ) : (
        <span className="ds-num" style={{ fontSize: 32, lineHeight: '38px', fontWeight: 650 }}>
          {value}
        </span>
      )}
      <span className="ds-field-hint">{errored && value === null ? 'Нет данных' : hint}</span>
    </Link>
  );
}

export function OverviewStats({
  active,
  overdue,
  inReview,
  waitingReception,
  tasksErrored,
  receptionErrored,
}: {
  active: number | null;
  overdue: number | null;
  inReview: number | null;
  waitingReception: number | null;
  tasksErrored: boolean;
  receptionErrored: boolean;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 16 }} className="dashboard-stats-grid">
      <StatCard icon={SquareKanban} label="Активные задачи" value={active} hint="В рабочем контуре" href="/tasks?filter=active" errored={tasksErrored} />
      <StatCard icon={Clock} label="Просрочены" value={overdue} hint="Требуют внимания" href="/tasks?filter=overdue" errored={tasksErrored} />
      <StatCard icon={Check} label="На проверке" value={inReview} hint="Ожидают решения" href="/tasks?filter=review" errored={tasksErrored} />
      <StatCard icon={DoorOpen} label="В приёмной" value={waitingReception} hint="Вопросы сотрудников" href="/reception" errored={receptionErrored} />
    </div>
  );
}

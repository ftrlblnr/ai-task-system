'use client';

import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import type { DashboardEventItem } from '@ai-task-system/shared-types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert } from '@/components/ui/alert';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026, раздел 10). Порядок уже задан
// сервером (startAt asc, только CONFIRMED и ещё не завершившиеся — идущее
// сейчас событие естественно идёт первым). «Сейчас» — вычисляется на
// клиенте в момент рендера (startAt<=now<=endAt), без отдельного флага с
// бэкенда — проверка дешёвая и не требует повторного похода на сервер.
function isOngoing(item: DashboardEventItem): boolean {
  const now = Date.now();
  return new Date(item.startAt).getTime() <= now && now <= new Date(item.endAt).getTime();
}

function formatWhen(item: DashboardEventItem): string {
  const date = new Date(item.startAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  if (item.allDay) return `${date} · Весь день`;
  const time = new Date(item.startAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
}

export function UpcomingEvents({ items, loading, errored }: { items: DashboardEventItem[] | null; loading: boolean; errored: boolean }) {
  return (
    <Card
      title="Ближайшие встречи"
      subtitle="Ваш календарь"
      actions={
        <Link href="/calendar" className="ds-field-hint" style={{ textDecoration: 'none' }}>
          Календарь ↗
        </Link>
      }
    >
      {loading && (
        <div style={{ display: 'flex', gap: 12 }}>
          <Skeleton height={64} width="33%" />
          <Skeleton height={64} width="33%" />
          <Skeleton height={64} width="33%" />
        </div>
      )}
      {!loading && errored && !items && <Alert tone="danger">Данные недоступны</Alert>}
      {!loading && items && items.length === 0 && <EmptyState title="Предстоящих встреч нет" />}
      {!loading && items && items.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {items.map((ev) => (
            <Link
              key={ev.id}
              href={`/calendar?event=${ev.id}`}
              className="ds-card ds-card-sunken"
              style={{ flex: '1 1 220px', minWidth: 200, display: 'flex', flexDirection: 'column', gap: 6, textDecoration: 'none', color: 'inherit' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--ink-3)' }}>
                <CalendarDays size={14} strokeWidth={1.75} />
                <span className="ds-field-hint">{formatWhen(ev)}</span>
                {isOngoing(ev) && <Badge tone="warn">Сейчас</Badge>}
              </div>
              <strong style={{ fontSize: 14 }}>{ev.title}</strong>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

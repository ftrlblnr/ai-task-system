'use client';

import Link from 'next/link';
import type { ReceptionNotificationStatus, ReceptionRequestItem } from '@ai-task-system/shared-types';
import { Card } from '@/components/ui/card';
import { Avatar } from '@/components/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert } from '@/components/ui/alert';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026, раздел 9). Текущий вызов (если
// есть) — отдельной строкой, видим независимо от списка ожидающих. Клик по
// обращению открывает /reception?focus=<id> — страница приёмной сама
// подсвечивает/прокручивает к нему (см. правку reception/page.tsx).
export function ReceptionPreview({
  current,
  items,
  loading,
  errored,
}: {
  current: (ReceptionRequestItem & { notificationStatus: ReceptionNotificationStatus | null }) | null | undefined;
  items: ReceptionRequestItem[] | null;
  loading: boolean;
  errored: boolean;
}) {
  return (
    <Card
      title="Приёмная"
      subtitle="Люди и вопросы"
      actions={
        <Link href="/reception" className="ds-field-hint" style={{ textDecoration: 'none' }}>
          Открыть ↗
        </Link>
      }
    >
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      )}
      {!loading && errored && !items && <Alert tone="danger">Данные недоступны</Alert>}

      {!loading && current && (
        <Link
          href={`/reception?focus=${current.id}`}
          className="ds-card ds-card-sunken"
          style={{ display: 'block', marginBottom: 12, textDecoration: 'none', color: 'inherit', borderLeft: '3px solid var(--warn)' }}
        >
          <span className="ds-field-hint">Сейчас вызван</span>
          <p style={{ margin: '2px 0 0', fontWeight: 600 }}>{current.author.fullName}</p>
          <p className="ds-field-hint" style={{ margin: '2px 0 0' }}>{current.title}</p>
        </Link>
      )}

      {!loading && items && items.length === 0 && !current && <EmptyState title="Ожидающих вопросов нет" />}

      {!loading && items && items.length > 0 && (
        <ul className="plain-list">
          {items.map((item) => (
            <li key={item.id} className="plain-list-row">
              <Link
                href={`/reception?focus=${item.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textDecoration: 'none', color: 'inherit' }}
              >
                <Avatar name={item.author.fullName} size={30} />
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{item.author.fullName}</p>
                  <p className="ds-field-hint" style={{ margin: '2px 0 0' }}>{item.title}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {!loading && (items?.length ?? 0) > 0 && (
        <Link href="/reception" className="ds-field-hint" style={{ display: 'inline-block', marginTop: 10, textDecoration: 'none' }}>
          Управлять очередью ↗
        </Link>
      )}
    </Card>
  );
}

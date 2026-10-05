'use client';

import Link from 'next/link';
import { AlertTriangle, Plus } from 'lucide-react';
import type { DashboardTaskItem } from '@ai-task-system/shared-types';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert } from '@/components/ui/alert';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026, раздел 8). Порядок уже задан
// сервером (DashboardService.getTasksSection) — здесь только рендер, без
// повторной сортировки. Просрочка — отдельный текстовый индикатор (иконка
// + слово), НЕ только цвет (ТЗ: "Одного цветного индикатора недостаточно").
function formatDueDate(value: string | null): string {
  if (!value) return 'Без срока';
  return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

export function AttentionTasks({ items, loading, errored }: { items: DashboardTaskItem[] | null; loading: boolean; errored: boolean }) {
  return (
    <Card
      title="В центре внимания"
      subtitle="Ближайшие действия"
      actions={
        <Link href="/tasks" className="ds-field-hint" style={{ textDecoration: 'none' }}>
          Все задачи ↗
        </Link>
      }
    >
      {loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Skeleton height={48} />
          <Skeleton height={48} />
          <Skeleton height={48} />
        </div>
      )}
      {!loading && errored && !items && <Alert tone="danger">Данные недоступны</Alert>}
      {!loading && items && items.length === 0 && (
        <EmptyState title="Активных задач пока нет">
          <Link href="/tasks/new" className="ds-btn ds-btn-primary ds-btn-sm">
            <Plus size={14} strokeWidth={1.75} />
            Создать задачу
          </Link>
        </EmptyState>
      )}
      {!loading && items && items.length > 0 && (
        <ul className="plain-list">
          {items.map((t) => (
            <li key={t.id} className="plain-list-row">
              <Link href={`/tasks/${t.id}`} style={{ display: 'block', width: '100%', textDecoration: 'none', color: 'inherit' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <p
                      style={{
                        margin: 0,
                        fontWeight: 600,
                        fontSize: 14,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {t.title}
                    </p>
                    <p className="ds-field-hint" style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {t.assignee?.fullName ?? 'Без исполнителя'}
                      <StatusBadge status={t.status} />
                    </p>
                  </div>
                  <div style={{ flex: 'none', textAlign: 'right' }}>
                    <div style={{ fontSize: 12, color: t.isOverdue ? 'var(--danger)' : 'var(--ink-3)', fontWeight: t.isOverdue ? 600 : 400 }}>
                      {formatDueDate(t.dueDate)}
                    </div>
                    {t.isOverdue && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end', color: 'var(--danger)', fontSize: 12, marginTop: 2 }}>
                        <AlertTriangle size={12} strokeWidth={1.75} />
                        Просрочена
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

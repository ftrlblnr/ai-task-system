import type { ReactNode } from 'react';
import type { TaskStatus } from '@ai-task-system/shared-types';
import { cx } from './button';

// Порт project/components/src/index.jsx Badge/StatusBadge. Тона: Badge/
// README.md. StatusBadge — подписи короче, чем lib/labels.ts STATUS_LABELS
// (там «Возвращена на доработку», тут «На доработке») — так в эталоне.

export type BadgeTone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'review' | 'agent' | 'draft' | 'outline';

interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Badge({ tone = 'neutral', dot, children, className }: BadgeProps) {
  return <span className={cx('ds-badge', tone !== 'neutral' && `ds-badge-${tone}`, dot && 'ds-badge-dot', className)}>{children}</span>;
}

const STATUS: Record<TaskStatus, [Exclude<BadgeTone, 'neutral'> | 'neutral', string]> = {
  DRAFT: ['draft', 'Черновик'],
  NEW: ['info', 'Новая'],
  IN_PROGRESS: ['warn', 'В работе'],
  IN_REVIEW: ['review', 'На проверке'],
  DONE: ['ok', 'Выполнена'],
  RETURNED: ['danger', 'На доработке'],
  CANCELLED: ['neutral', 'Отменена'],
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const [tone, label] = STATUS[status];
  return (
    <Badge tone={tone} dot={status !== 'DRAFT'}>
      {label}
    </Badge>
  );
}

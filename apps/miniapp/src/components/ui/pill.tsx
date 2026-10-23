import type { ReactNode } from 'react';
import type { TaskStatus } from '@ai-task-system/shared-types';
import { STATUS_LABELS } from '@/lib/labels';
import { cx } from './button';

// Цветная «пилюля» редизайна (MINIAPP_REDESIGN.md §3): оттенки из
// переопределений globals.css, а не ds-badge-* — у тех тона пакета
// design-tokens, общего с web, и менять их нельзя.
export type PillTone = 'neutral' | 'orange' | 'blue' | 'purple' | 'teal';

export function Pill({ tone = 'neutral', children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={cx('pill', tone !== 'neutral' && `pill-${tone}`)}>{children}</span>;
}

// Цвет статуса задачи — по таблице токенов §3: «В работе» синий, «На
// проверке» фиолетовый, «Готово» бирюзовый, «вернули» — акцентный.
const STATUS_TONE: Record<TaskStatus, PillTone> = {
  DRAFT: 'neutral',
  NEW: 'neutral',
  IN_PROGRESS: 'blue',
  IN_REVIEW: 'purple',
  DONE: 'teal',
  RETURNED: 'orange',
  CANCELLED: 'neutral',
};

export function StatusPill({ status }: { status: TaskStatus }) {
  return <Pill tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Pill>;
}

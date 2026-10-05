import type { HTMLAttributes, ReactNode } from 'react';
import { Plus } from 'lucide-react';
import type { TaskStatus } from '@ai-task-system/shared-types';
import { cx } from './button';
import { IconButton } from './button';

// Порт KanbanColumn — web-only (канбан не существует в Mini App).
// KanbanColumn/README.md: статус-точка цветом DOT, счётчик — явный count,
// если передан (считает видимые задачи ПОСЛЕ фильтра, не React.Children).

const STATUS_LABELS: Record<TaskStatus, string> = {
  DRAFT: 'Черновик',
  NEW: 'Новая',
  IN_PROGRESS: 'В работе',
  IN_REVIEW: 'На проверке',
  DONE: 'Выполнена',
  RETURNED: 'Возвращена на доработку',
  CANCELLED: 'Отменена',
};

const DOT: Record<TaskStatus, string> = {
  DRAFT: 'var(--ink-3)',
  NEW: 'var(--info)',
  IN_PROGRESS: 'var(--warn)',
  IN_REVIEW: 'var(--review)',
  DONE: 'var(--ok)',
  RETURNED: 'var(--danger)',
  CANCELLED: 'var(--ink-3)',
};

interface KanbanColumnProps extends HTMLAttributes<HTMLElement> {
  status: TaskStatus;
  count: number;
  over?: boolean;
  isEmpty?: boolean;
  onAdd?: () => void;
  children?: ReactNode;
}

export function KanbanColumn({ status, count, over, isEmpty, onAdd, children, className, ...rest }: KanbanColumnProps) {
  return (
    <section className={cx('ds-col', over && 'is-over', className)} aria-label={STATUS_LABELS[status]} {...rest}>
      <header className="ds-col-head">
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: DOT[status],
            outline: status === 'DRAFT' ? '1px dashed var(--ink-3)' : undefined,
          }}
        />
        {STATUS_LABELS[status]}
        <span className="ds-col-count">{count}</span>
        {onAdd && <IconButton icon={Plus} label="Новая задача" size="sm" onClick={onAdd} />}
      </header>
      {isEmpty ? <div className="ds-col-empty">Перетащите задачу сюда</div> : children}
    </section>
  );
}

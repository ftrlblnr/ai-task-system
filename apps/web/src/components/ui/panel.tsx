import type { ReactNode } from 'react';
import Link from 'next/link';
import { Play } from 'lucide-react';
import type { SkillEffort, SkillModel } from '@ai-task-system/shared-types';
import { SKILL_EFFORT_LABELS, SKILL_MODEL_LABELS } from '@ai-task-system/shared-types';
import { cx, type IconComponent } from './button';

// Пульт руководителя (ARMS, фаза 6): панель с заголовком капсом и иконкой,
// статус мелким капсом справа, чип модели, ▶, полоса показателей. Общие
// для пульта и новых страниц.

interface PanelProps {
  icon: IconComponent;
  title: string;
  // Ссылка «все» в заголовке.
  href?: string;
  hrefLabel?: string;
  // Справа в заголовке вместо ссылки (счётчик, кнопка).
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Panel({ icon: Icon, title, href, hrefLabel = 'Открыть', aside, children, className }: PanelProps) {
  return (
    <section className={cx('ds-panel', className)} aria-label={title}>
      <PanelHeader icon={Icon} title={title} href={href} hrefLabel={hrefLabel} aside={aside} />
      {children}
    </section>
  );
}

export function PanelHeader({ icon: Icon, title, href, hrefLabel = 'Открыть', aside }: Omit<PanelProps, 'children' | 'className'>) {
  return (
    <header className="ds-panel-head">
      <Icon size={14} strokeWidth={2} />
      <h2>{title}</h2>
      <span className="ds-spacer" />
      {aside}
      {href && (
        <Link href={href} className="ds-panel-link">
          {hrefLabel} ↗
        </Link>
      )}
    </header>
  );
}

export type StatusTone = 'next' | 'ok' | 'info' | 'warn' | 'danger' | 'muted';

export function StatusTag({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return <span className={cx('ds-status-tag', `is-${tone}`)}>{children}</span>;
}

export function ModelChip({ model, effort }: { model: SkillModel; effort?: SkillEffort }) {
  return (
    <span className="ds-model-chip">
      <span className={cx('ds-model-name', `is-${model.toLowerCase()}`)}>{SKILL_MODEL_LABELS[model]}</span>
      {effort && <span className="ds-model-effort">{SKILL_EFFORT_LABELS[effort]}</span>}
    </span>
  );
}

export function RunButton({ label, busy, onRun }: { label: string; busy?: boolean; onRun: () => void }) {
  return (
    <button type="button" className="ds-run-btn" aria-label={label} title={label} disabled={busy} onClick={onRun}>
      {busy ? <span className="ds-spinner" /> : <Play size={14} strokeWidth={2} />}
    </button>
  );
}

import type { CSSProperties, ReactNode } from 'react';
import { cx } from './button';
import { AgentButton } from '@/components/agent-panel/agent-panel';

// Порт Card/PageHeader. Card/README.md: tone="sunken" — вторичные блоки,
// tone="agent" — контекст, подготовленный ИИ. Не вкладывать карточку в
// карточку. PageHeader/README.md: не больше одной primary-кнопки в actions.

type CardTone = 'sunken' | 'agent';

interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tone?: CardTone;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Card({ title, subtitle, actions, tone, children, className, style }: CardProps) {
  return (
    <section className={cx('ds-card', tone && `ds-card-${tone}`, className)} style={style}>
      {(title || actions) && (
        <div className="ds-card-head">
          <div>
            {title && <h2 className="ds-card-title">{title}</h2>}
            {subtitle && <p className="ds-card-sub">{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

interface PageHeaderProps {
  // Моно-строка над заголовком (редизайн web: «Фильтр · N задач», дата).
  kicker?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ kicker, title, description, actions }: PageHeaderProps) {
  return (
    <header className="ds-pagehead">
      <div>
        {kicker && <span className="page-kicker">{kicker}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {/* «Агент» — в шапке любой страницы (редизайн W2), открывает панель. */}
      <div className="ds-pagehead-actions">
        {actions}
        <AgentButton />
      </div>
    </header>
  );
}

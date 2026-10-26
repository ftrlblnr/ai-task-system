import type { ReactNode } from 'react';
import { cx } from './button';

// Строка состояния подключения (Google Calendar, Plaud, окно регистрации —
// редизайн web W6): точка-статус, что подключено, мелкая мета, действия
// справа. Инструкции по настройке — под строкой, только по кнопке.

interface ConnectionBarProps {
  on: boolean;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export function ConnectionBar({ on, title, meta, actions, children }: ConnectionBarProps) {
  return (
    <section className="conn-bar">
      <div className="conn-bar-row">
        <span className={cx('conn-bar-dot', on && 'is-on')} aria-hidden="true" />
        <span className="conn-bar-text">
          <span className="conn-bar-title">{title}</span>
          {meta && <span className="conn-bar-meta">{meta}</span>}
        </span>
        {actions && <span className="conn-bar-actions">{actions}</span>}
      </div>
      {children}
    </section>
  );
}

import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import type { IconComponent } from './button';

// Порт EmptyState — приглашение к действию: иконка, заголовок, одно
// предложение, кнопки. Без иллюстраций и шуток (EmptyState/README.md).

interface EmptyStateProps {
  icon?: IconComponent;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

export function EmptyState({ icon: Icon = Inbox, title, description, children }: EmptyStateProps) {
  return (
    <div className="ds-empty">
      <span className="ds-empty-icon">
        <Icon size={22} strokeWidth={1.75} />
      </span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children && <div className="ds-empty-actions">{children}</div>}
    </div>
  );
}

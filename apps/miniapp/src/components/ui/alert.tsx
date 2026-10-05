import type { ReactNode } from 'react';
import { CircleAlert, Info, Check } from 'lucide-react';
import type { IconComponent } from './button';
import { cx } from './button';

// Порт Alert — встроенное сообщение в потоке страницы (Alert/README.md):
// title — что случилось, children — что делать, action — кнопка-исправление.

type AlertTone = 'neutral' | 'danger' | 'warn' | 'info' | 'ok';

const AL_ICON: Record<AlertTone, IconComponent> = {
  danger: CircleAlert,
  warn: CircleAlert,
  info: Info,
  ok: Check,
  neutral: Info,
};

interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}

export function Alert({ tone = 'neutral', title, children, action }: AlertProps) {
  const Icon = AL_ICON[tone];
  return (
    <div className={cx('ds-alert', `ds-alert-${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={18} strokeWidth={1.75} />
      <div className="ds-alert-body">
        {title && <b>{title}</b>}
        {children}
      </div>
      {action}
    </div>
  );
}

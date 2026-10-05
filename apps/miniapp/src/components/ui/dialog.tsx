'use client';

import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton, cx } from './button';

// Порт Dialog — модалка на scrim; в Mini App sheet=true (bottom-sheet).
// Закрытие — крестик, Esc, клик по затемнению (Dialog/README.md,
// project/agent-motion.md «Фокус и доступность»: role=dialog, aria-modal).

interface DialogProps {
  open?: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose?: () => void;
  footer?: ReactNode;
  children?: ReactNode;
  inline?: boolean;
  sheet?: boolean;
}

export function Dialog({ open = true, title, description, onClose, footer, children, inline, sheet }: DialogProps) {
  useEffect(() => {
    if (!open || !onClose) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose?.();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function onScrimClick(e: MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose?.();
  }

  if (sheet) {
    return (
      <div className={cx('ds-scrim', 'ds-scrim-sheet', inline && 'ds-scrim-inline')} onClick={onScrimClick}>
        <div className="ds-sheet" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
          <div className="ds-sheet-grab" />
          <div className="ds-dialog-head">
            <div style={{ flex: 1 }}>
              <h2 style={{ margin: 0, fontSize: 17, lineHeight: '24px', fontWeight: 600 }}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <IconButton icon={X} label="Закрыть" size="sm" onClick={onClose} />
          </div>
          <div className="ds-dialog-body">{children}</div>
          {footer && <div className="ds-dialog-foot">{footer}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={cx('ds-scrim', inline && 'ds-scrim-inline')} onClick={onScrimClick}>
      <div className="ds-dialog" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="ds-dialog-head">
          <div style={{ flex: 1 }}>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon={X} label="Закрыть" size="sm" onClick={onClose} />
        </div>
        <div className="ds-dialog-body">{children}</div>
        {footer && <div className="ds-dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

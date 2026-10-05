import type { CSSProperties, ReactNode } from 'react';
import { Undo2 } from 'lucide-react';

// Порт Toast — временное уведомление внизу экрана с «Отменить» и круговым
// таймером (Toast/README.md). Главный сценарий — откат голосовой команды.
// onAction={null} — без кнопки. Один тост за раз, слой z-toast.

interface ToastProps {
  children?: ReactNode;
  actionLabel?: string;
  onAction?: (() => void) | null;
  durationMs?: number;
}

export function Toast({ children, actionLabel = 'Отменить', onAction, durationMs = 6000 }: ToastProps) {
  return (
    <div className="ds-toast" role="status" style={{ '--toast-ms': `${durationMs}ms` } as CSSProperties}>
      <svg className="ds-toast-progress" viewBox="0 0 18 18">
        <circle className="track" cx="9" cy="9" r="7" />
        <circle className="bar" cx="9" cy="9" r="7" />
      </svg>
      <span>{children}</span>
      {onAction !== null && (
        <button type="button" className="ds-btn ds-btn-sm" onClick={onAction}>
          <Undo2 size={14} strokeWidth={1.75} />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

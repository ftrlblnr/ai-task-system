'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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

// Короткий тост результата действия в Mini App (редизайн §4.1): над нижней
// панелью, без кнопки, гаснет через 1.8 с. Новый вызов заменяет текущий —
// два тоста подряд не копятся в стопку.
const APP_TOAST_MS = 1800;

export function useAppToast(): [ReactNode, (message: string) => void] {
  const [message, setMessage] = useState<{ text: string; id: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage({ text, id: Date.now() });
    timer.current = setTimeout(() => setMessage(null), APP_TOAST_MS);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const node = message ? (
    <div className="app-toast" key={message.id}>
      <Toast onAction={null} durationMs={APP_TOAST_MS}>
        {message.text}
      </Toast>
    </div>
  ) : null;
  return [node, show];
}

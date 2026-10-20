import { useRef } from 'react';

// Ключ одной попытки мутации (Idempotency-Key): переиспользуется при повторе
// ТОГО ЖЕ действия (двойной клик, ретрай после таймаута), сбрасывается на
// новый только после успеха — тот же приём, что reception/page.tsx.
export function useIdempotencyKey(): { key: () => string; reset: () => void } {
  const ref = useRef<string | null>(null);
  return {
    key: () => {
      if (!ref.current) ref.current = crypto.randomUUID();
      return ref.current;
    },
    reset: () => {
      ref.current = null;
    },
  };
}

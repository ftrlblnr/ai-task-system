import { useRef } from 'react';

// Ключ одной попытки мутации (Idempotency-Key): переиспользуется при повторе
// ТОГО ЖЕ действия (двойной клик, ретрай после таймаута, 5xx). Сбрасывается
// после успеха и после отказа 4xx: сервер запомнил отказ под этим ключом, и
// исправленная повторная отправка с ним дала бы IDEMPOTENCY_CONFLICT
// (прод 21.10.2026, reception/page.tsx). Зеркало apps/web/src/lib/use-idempotency-key.ts.
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

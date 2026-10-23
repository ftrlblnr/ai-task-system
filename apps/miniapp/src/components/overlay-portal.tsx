'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Оверлеи — порталом в document.body: так position: fixed считается от
// viewport, а не от ближайшего предка с transform/скроллом, и оверлей
// гарантированно ложится поверх нижней панели. (История: при свайп-
// оболочке трек с transform сдвигал оверлеи на сотни пикселей, 01.09.2026.)
export function OverlayPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  // Стандартный SSR-safe идиом "мы точно на клиенте, после гидратации" —
  // не "подстройка state под изменившийся проп" (react-hooks/set-state-
  // in-effect, первый реальный прогон lint в CI, аудит 10.09.2026, п. 5.2,
  // ложное срабатывание на этом идиоме).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

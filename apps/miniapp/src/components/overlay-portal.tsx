'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// position: fixed внутри оверлеев ломается, если рендерить их как обычных
// детей внутри SwipeShell: .swipe-track двигается через CSS transform, а
// ЛЮБОЙ transform на предке (даже translateX(0), т.е. единичная матрица) —
// по спецификации CSS создаёт новый containing block для потомков с
// position: fixed. В итоге оверлей позиционировался не от viewport, а от
// .swipe-track, из-за чего сдвигался на сотни пикселей за пределы экрана —
// найдено 01.09.2026 через getBoundingClientRect() (overlay.left ≈ -830px).
// Портал в document.body — стандартный обход этой проблемы.
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

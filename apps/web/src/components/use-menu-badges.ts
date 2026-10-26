'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { MenuBadges } from '@ai-task-system/shared-types';
import { api } from '@/lib/api';

// Бейджи меню (редизайн web W5, docs/WEB_REDESIGN.md §4.1): GET /me/badges
// раз в минуту на видимой вкладке и при переходе между разделами (разобрал
// почту — вернулся, цифра уже новая). Администратор видит почту
// руководителя — как на /mail по умолчанию. Ошибка — бейджи прежние.
const POLL_MS = 60_000;

export function useMenuBadges(userId: string | undefined, actAsLeader: boolean) {
  const [badges, setBadges] = useState<MenuBadges | null>(null);
  const pathname = usePathname();

  const refresh = useCallback(() => {
    if (!userId) return;
    api
      .get<MenuBadges>('/me/badges', undefined, actAsLeader ? { 'X-Act-As': 'leader' } : undefined)
      .then(setBadges)
      .catch(() => {});
  }, [userId, actAsLeader]);

  useEffect(refresh, [refresh, pathname]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { badges, refresh };
}

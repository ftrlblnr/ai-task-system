'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import type { Role } from '@ai-task-system/shared-types';

// requireRole — одна роль или список (ролевая модель 20.10.2026: большинство
// разделов руководителя открыты и администратору, см. MANAGER_ROLES).
export function Protected({ children, requireRole }: { children: ReactNode; requireRole?: Role | readonly Role[] }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const allowed = !requireRole || (!!user && (typeof requireRole === 'string' ? user.role === requireRole : requireRole.includes(user.role)));

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!allowed) {
      router.replace('/tasks');
    }
  }, [loading, user, allowed, router]);

  if (loading || !user || !allowed) {
    return <p className="ds-field-hint">Загрузка…</p>;
  }

  return <>{children}</>;
}

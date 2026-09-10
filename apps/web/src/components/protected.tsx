'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import type { Role } from '@ai-task-system/shared-types';

export function Protected({ children, requireRole }: { children: ReactNode; requireRole?: Role }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (requireRole && user.role !== requireRole) {
      router.replace('/tasks');
    }
  }, [loading, user, requireRole, router]);

  if (loading || !user || (requireRole && user.role !== requireRole)) {
    return <p className="hint">Загрузка…</p>;
  }

  return <>{children}</>;
}

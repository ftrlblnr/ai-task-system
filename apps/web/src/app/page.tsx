'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { DashboardPage } from '@/components/dashboard/dashboard-page';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026, раздел 4) — только OWNER;
// остальные роли по-прежнему уходят в /tasks (как было раньше). Права
// проверяются и на сервере (@Roles(Role.OWNER) на GET /dashboard/overview)
// — редирект здесь не замена авторизации, просто не показываем лишний
// переходный экран не-OWNER пользователю.
export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace('/login');
    } else if (user.role !== 'OWNER') {
      router.replace('/tasks');
    }
  }, [loading, user, router]);

  if (loading || !user || user.role !== 'OWNER') return null;

  return <DashboardPage />;
}

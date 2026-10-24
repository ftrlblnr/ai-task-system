'use client';

import { useState } from 'react';
import { isManagerRole } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { EmployeeReception } from './reception/employee-reception';
import { ManagerReception } from './reception/manager-reception';

// Руководителю — очередь (редизайн M4), сотруднику — свои вопросы. ADMIN
// тоже подаёт вопросы владельцу — ему «Мои вопросы» открываются из очереди
// (как вкладка «Мои обращения» в web). Права на действия очереди всё равно
// проверяет сервер (@Roles(MANAGER_ROLES)).
export function ReceptionScreen({ active = true }: { active?: boolean }) {
  const { user } = useAuth();
  const [mine, setMine] = useState(false);
  if (!user) return null;
  if (!isManagerRole(user.role)) return <EmployeeReception active={active} />;
  if (mine) return <EmployeeReception active={active} onBack={() => setMine(false)} />;
  return <ManagerReception active={active} onOpenMine={user.role === 'ADMIN' ? () => setMine(true) : undefined} />;
}

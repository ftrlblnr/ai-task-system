'use client';

import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from 'react';
import type { EmployeeProfile } from '@ai-task-system/shared-types';
import { api, setActAsLeader } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { SegmentedControl } from '@/components/ui';

type Mode = 'leader' | 'self';

const ActingAsLeaderContext = createContext(false);

// true — страница показывает данные руководителя от имени администратора:
// подключать/отключать её интеграции нельзя (API ответит 403).
export function useActingAsLeader(): boolean {
  return useContext(ActingAsLeaderContext);
}

// Ролевая модель 20.10.2026 — администратор ведёт и свои календарь/почту,
// и руководителя. Переключатель над страницей; по умолчанию — данные
// руководителя (ради этого роль и заведена). Дети монтируются заново при
// каждом переключении и только ПОСЛЕ того, как флаг в api.ts выставлен,
// иначе их первые запросы ушли бы без X-Act-As.
export function DataOwnerScope({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [mode, setMode] = useState<Mode>('leader');
  const [appliedMode, setAppliedMode] = useState<Mode | null>(null);
  const [leaderName, setLeaderName] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    api
      .get<EmployeeProfile[]>('/employees')
      .then((list) => setLeaderName(list.find((e) => e.role === 'OWNER')?.fullName ?? null))
      .catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    setActAsLeader(isAdmin && mode === 'leader');
    // Флаг модуля api.ts — внешнее состояние, дети ждут его применения
    // (тот же случай синхронизации с внешней системой, что в auth-context).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAppliedMode(mode);
    return () => setActAsLeader(false);
  }, [isAdmin, mode]);

  const acting = isAdmin && mode === 'leader';

  return (
    <ActingAsLeaderContext.Provider value={acting}>
      {isAdmin && (
        <div style={{ marginBottom: 16 }}>
          <SegmentedControl
            label="Чьи данные"
            options={[
              { value: 'leader', label: leaderName ?? 'Руководитель' },
              { value: 'self', label: 'Мои' },
            ]}
            value={mode}
            onChange={(v) => setMode(v as Mode)}
          />
        </div>
      )}
      {appliedMode === mode && <Fragment key={mode}>{children}</Fragment>}
    </ActingAsLeaderContext.Provider>
  );
}

'use client';

import { Suspense } from 'react';
import { Protected } from '@/components/protected';
import { TasksView } from '@/components/tasks/tasks-view';

export default function TasksPage() {
  return (
    <Protected>
      <Suspense fallback={<p className="ds-field-hint">Загрузка…</p>}>
        <TasksView />
      </Suspense>
    </Protected>
  );
}

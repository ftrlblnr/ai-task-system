'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Protected } from '@/components/protected';
import { KanbanBoard } from '@/components/kanban-board';
import { PageHeader } from '@/components/ui/card';

// Раздел 5 ТЗ (скорректировано 28.08.2026): ставить задачи друг другу,
// включая руководителю, может любой участник — кнопка больше не только
// для OWNER.
function TasksPageHeader() {
  return (
    <PageHeader
      title="Задачи"
      actions={
        <Link href="/tasks/new" className="ds-btn ds-btn-primary">
          <Plus size={18} strokeWidth={1.75} />
          Создать задачу
        </Link>
      }
    />
  );
}

export default function TasksPage() {
  return (
    <Protected>
      <TasksPageHeader />
      <KanbanBoard />
    </Protected>
  );
}

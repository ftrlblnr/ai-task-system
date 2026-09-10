'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { Protected } from '@/components/protected';
import { KanbanBoard } from '@/components/kanban-board';

// Раздел 5 ТЗ (скорректировано 28.08.2026): ставить задачи друг другу,
// включая руководителю, может любой участник — кнопка больше не только
// для OWNER.
function TasksPageHeader() {
  return (
    <div className="page-header">
      <h1>Задачи</h1>
      <Link href="/tasks/new" className="btn">
        <Plus size={16} strokeWidth={2.5} />
        Создать задачу
      </Link>
    </div>
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

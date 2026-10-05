import type { TaskPriority } from '@ai-task-system/shared-types';

// Порт PriorityMark — заменяет цветную левую рамку карточки задачи
// (project/components/PriorityMark/README.md). В карточке — showLabel=false,
// в детальной странице и фильтрах — с подписью.

const PRIO: Record<TaskPriority, string> = {
  LOW: 'Низкий',
  MEDIUM: 'Средний',
  HIGH: 'Высокий',
  CRITICAL: 'Критический',
};

export function PriorityMark({ priority = 'MEDIUM', showLabel = true }: { priority?: TaskPriority; showLabel?: boolean }) {
  return (
    <span className={`ds-prio ds-prio-${priority}`} title={`Приоритет: ${PRIO[priority]}`}>
      {priority === 'CRITICAL' ? (
        <span className="ds-prio-crit-flag">!</span>
      ) : (
        <span className="ds-prio-bars">
          <i />
          <i />
          <i />
        </span>
      )}
      {showLabel && PRIO[priority]}
    </span>
  );
}

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Avatar } from '@/components/avatar';
import { cx } from './button';

// Порт Chip — сущность в строке (участник, наблюдатель, фильтр), может
// удаляться. Chip/README.md: `avatar` — имя для мини-аватара, `agent` —
// предложено ассистентом и ещё не подтверждено.

interface ChipProps {
  children?: ReactNode;
  avatar?: string;
  agent?: boolean;
  onRemove?: () => void;
}

export function Chip({ children, avatar, agent, onRemove }: ChipProps) {
  return (
    <span className={cx('ds-chip', agent && 'ds-chip-agent')}>
      {avatar && <Avatar name={avatar} size={20} />}
      {children}
      {onRemove && (
        <button type="button" className="ds-chip-x" aria-label="Убрать" onClick={onRemove}>
          <X size={14} strokeWidth={1.75} />
        </button>
      )}
    </span>
  );
}

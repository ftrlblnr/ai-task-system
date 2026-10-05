import type { ReactNode } from 'react';
import { KanbanSquare, Calendar, Clock, MapPin, FileAudio, ExternalLink } from 'lucide-react';
import { Avatar } from '@/components/avatar';
import { AgentMark } from './agent-mark';
import { Chip } from './chip';
import { Alert } from './alert';
import { Button } from './button';
import { cx } from './button';

// Порт EntityCard — задача/событие, созданные ассистентом, в ленте чата.
// `fresh` — материализация (agent-motion.md) только для сущности, созданной
// В ТЕКУЩЕМ стриме; при открытии истории позже — всегда `fresh=false` (см.
// freshMessageIds в assistant/page.tsx и assistant-screen.tsx).
interface EntityCardProps {
  kind: 'task' | 'event';
  title: string;
  status?: ReactNode;
  due?: string;
  assignee?: string | null;
  time?: string;
  location?: string | null;
  participants?: string[];
  warning?: string | null;
  source?: { title: string; ts?: string | null } | null;
  fresh?: boolean;
  onOpen?: () => void;
}

export function EntityCard({ kind, title, status, due, assignee, time, location, participants, warning, source, fresh, onOpen }: EntityCardProps) {
  return (
    <article className={cx('ds-entity', fresh && 'is-fresh')}>
      <div className="ds-entity-kind">
        {kind === 'task' ? <KanbanSquare size={14} strokeWidth={1.75} /> : <Calendar size={14} strokeWidth={1.75} />}
        {kind === 'task' ? 'Задача' : 'Встреча'}
        <span className="ds-entity-prov">
          <AgentMark size={12} state="done" enter={fresh} />
          {fresh ? 'Создано только что' : 'Создано ассистентом'}
        </span>
      </div>
      <h4 className="ds-entity-title">{title}</h4>
      <div className="ds-entity-meta">
        {status}
        {due && (
          <span>
            <Calendar size={14} strokeWidth={1.75} />
            до {due}
          </span>
        )}
        {time && (
          <span>
            <Clock size={14} strokeWidth={1.75} />
            {time}
          </span>
        )}
        {location && (
          <span>
            <MapPin size={14} strokeWidth={1.75} />
            {location}
          </span>
        )}
        {assignee && (
          <span>
            <Avatar name={assignee} size={18} />
            {assignee}
          </span>
        )}
      </div>
      {participants && participants.length > 0 && (
        <div className="ds-task-meta">
          {participants.map((p) => (
            <Chip key={p} avatar={p}>
              {p}
            </Chip>
          ))}
        </div>
      )}
      {source && (
        <div className="ds-entity-source">
          <FileAudio size={14} strokeWidth={1.75} />
          {source.title}
          {source.ts && <span className="ds-ts">{source.ts}</span>}
        </div>
      )}
      {warning && <Alert tone="warn">{warning}</Alert>}
      {onOpen && (
        <div className="ds-entity-foot">
          <Button size="sm" variant="secondary" icon={ExternalLink} onClick={onOpen}>
            Открыть
          </Button>
        </div>
      )}
    </article>
  );
}

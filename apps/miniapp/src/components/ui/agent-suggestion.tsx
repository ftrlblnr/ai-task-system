import { Check, Undo2 } from 'lucide-react';
import type { ConfidenceLevel } from '@ai-task-system/shared-types';
import { cx } from './button';
import { Button } from './button';
import { Chip } from './chip';
import { Badge } from './badge';

// Порт project/components/src/index.jsx ConfidenceMeter/AgentSuggestion —
// карточка извлечённой из саммари встречи задачи (шаг 9 implementation.md).
// Короткие подписи — те же, что в эталоне (ConfidenceMeter/README.md), НЕ
// lib/labels.ts CONFIDENCE_LABELS (тот длиннее — «Высокая уверенность» — и
// используется в других местах; здесь короткая метка рядом с барами).
const CONF: Record<ConfidenceLevel, string> = { HIGH: 'Уверен', MEDIUM: 'Скорее да', LOW: 'Проверьте' };

export function ConfidenceMeter({ level = 'MEDIUM' as ConfidenceLevel }: { level?: ConfidenceLevel }) {
  return (
    <span className={`ds-conf ds-conf-${level}`} title={`Уверенность: ${CONF[level]}`}>
      <span className="ds-conf-bars">
        <i />
        <i />
        <i />
      </span>
      {CONF[level]}
    </span>
  );
}

interface AgentSuggestionProps {
  title: string;
  quote?: string | null;
  ts?: string | null;
  confidence?: ConfidenceLevel;
  assignee?: string | null;
  due?: string | null;
  state?: 'accepted' | 'rejected' | null;
  onAccept?: () => void;
  onReject?: () => void;
  onEdit?: () => void;
}

// Показывается ДО подтверждения — ничего не создаётся в БД, пока
// руководитель не нажмёт «Создать N задач» (см. task-extraction-modal.tsx).
export function AgentSuggestion({
  title,
  quote,
  ts,
  confidence = 'MEDIUM',
  assignee,
  due,
  state,
  onAccept,
  onReject,
  onEdit,
}: AgentSuggestionProps) {
  return (
    <div className={cx('ds-suggest', state === 'accepted' && 'is-accepted', state === 'rejected' && 'is-rejected')}>
      <div className="ds-suggest-head">
        <h4>{title}</h4>
        {assignee && <Chip avatar={assignee}>{assignee}</Chip>}
      </div>
      {quote && (
        <p className="ds-quote">
          {ts && <span className="ds-ts">{ts}</span>}«{quote}»
        </p>
      )}
      <div className="ds-suggest-foot">
        <ConfidenceMeter level={confidence} />
        {due && (
          <span className="ds-note" style={{ marginRight: 8 }}>
            до {due}
          </span>
        )}
        {state === 'accepted' ? (
          <Badge tone="agent">
            <Check size={12} strokeWidth={1.75} />
            Будет создана
          </Badge>
        ) : state === 'rejected' ? (
          <Button size="sm" variant="ghost" icon={Undo2} onClick={onReject}>
            Вернуть
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Изменить
            </Button>
            <Button size="sm" variant="ghost" onClick={onReject}>
              Пропустить
            </Button>
            <Button size="sm" variant="agent" icon={Check} onClick={onAccept}>
              Создать
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

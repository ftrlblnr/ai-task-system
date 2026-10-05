import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { AgentMark, type AgentMarkState } from './agent-mark';
import { Button } from './button';

// Порт AgentMessage — сообщение ассистента: метка слева, без пузыря.
// `state` переводится в состояние AgentMark (agent-motion.md): streaming/
// thinking → "thinking", error → "error", иначе "done".
type MessageState = 'pending' | 'streaming' | 'done' | 'error';

interface AgentMessageProps {
  state?: MessageState;
  children?: ReactNode;
  actions?: boolean;
  onCopy?: () => void;
}

export function AgentMessage({ state = 'done', children, actions = true, onCopy }: AgentMessageProps) {
  const [copied, setCopied] = useState(false);
  const markState: AgentMarkState = state === 'streaming' || state === 'pending' ? 'thinking' : state === 'error' ? 'error' : 'done';

  return (
    <div className="ds-msg-agent">
      <span className="ds-msg-agent-avatar">
        <AgentMark size={18} state={markState} />
      </span>
      <div className="ds-msg-agent-body">
        {children}
        {actions && state === 'done' && (
          <div className="ds-msg-actions">
            <Button
              size="sm"
              variant="ghost"
              icon={copied ? Check : Copy}
              onClick={() => {
                setCopied(true);
                onCopy?.();
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Скопировано' : 'Копировать'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

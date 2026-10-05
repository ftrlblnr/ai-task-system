import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { AgentMark } from './agent-mark';
import { cx } from './button';

// Порт ThinkingLine — одна строка статуса инструмента ассистента
// (agent-motion.md: "Шиммер мысли"). `time` (длительность выполнения) —
// проп на будущее: ToolActivityData (shared-types) сейчас отдаёт только
// `label`, без длительности, поэтому вызывающий код этот проп не передаёт.
export function ThinkingLine({ label, done, time }: { label: string; done?: boolean; time?: string }) {
  return (
    <div className={cx('ds-think', done && 'is-done')} aria-live="polite">
      {done ? (
        <span className="ds-think-check">
          <Check size={14} strokeWidth={1.75} />
        </span>
      ) : (
        <AgentMark size={16} state="thinking" />
      )}
      <span className="ds-think-label">{label}</span>
      {done && time && <span className="ds-think-time">{time}</span>}
    </div>
  );
}

// Несколько подряд идущих ThinkingLine одного ответа — обёртка задаёт
// отступ/анимацию появления новой строки (.ds-think-group в ds.css).
export function ThinkingGroup({ children }: { children: ReactNode }) {
  return <div className="ds-think-group">{children}</div>;
}

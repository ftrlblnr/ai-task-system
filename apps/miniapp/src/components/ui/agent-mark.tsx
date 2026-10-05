import { cx } from './button';

// Порт AgentMark — единственный визуальный символ ИИ в продукте («апертура»:
// кольцо, ядро, дуга). Стили и анимации — .ds-agentmark в ds.css (project/
// agent-motion.md: idle=дыхание, thinking=орбита, listening=рябь, done/error
// — статичные тона). Без state — статична, подходит для бренд-метки.

export type AgentMarkState = 'idle' | 'thinking' | 'listening' | 'done' | 'error';

const LABEL: Record<AgentMarkState, string> = {
  idle: 'Ассистент',
  thinking: 'Ассистент работает',
  listening: 'Ассистент слушает',
  done: 'Сделано ассистентом',
  error: 'Ошибка ассистента',
};

export function AgentMark({ state = 'idle', size = 20, enter }: { state?: AgentMarkState; size?: number; enter?: boolean }) {
  return (
    <span className={cx('ds-agentmark', enter && 'is-enter')} data-state={state} role="img" aria-label={LABEL[state]}>
      <svg width={size} height={size} viewBox="0 0 24 24">
        <circle className="am-ripple" cx="12" cy="12" r="9" />
        <circle className="am-ripple r2" cx="12" cy="12" r="9" />
        <circle className="am-ring" cx="12" cy="12" r="9.5" />
        <circle className="am-arc" cx="12" cy="12" r="9.5" />
        <circle className="am-core" cx="12" cy="12" r="4" />
      </svg>
    </span>
  );
}

import { cx } from './button';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026) — объёмная сфера AgentHero-
// блока, отдельно от AgentMark (маленький значок-«апертура» в сайдбаре).
// state="idle" не анимируется вовсе (halo/ring/core статичны) — раздел 12
// ТЗ: "Декоративная сфера в покое статична... Главная не имитирует фоновую
// работу ИИ". thinking/listening существуют для будущего переиспользования
// за пределами этой страницы, здесь не используются.
type AgentOrbSize = 'small' | 'default' | 'large';
type AgentOrbState = 'idle' | 'thinking' | 'listening';

interface AgentOrbProps {
  size?: AgentOrbSize;
  state?: AgentOrbState;
  className?: string;
}

export function AgentOrb({ size = 'default', state = 'idle', className }: AgentOrbProps) {
  return (
    <div
      className={cx(
        'ds-agent-orb',
        size === 'small' && 'ds-agent-orb--small',
        size === 'large' && 'ds-agent-orb--large',
        state !== 'idle' && `ds-agent-orb--${state}`,
        className,
      )}
      aria-hidden="true"
    >
      <div className="ds-agent-orb-halo" />
      <div className="ds-agent-orb-ring" />
      <div className="ds-agent-orb-core" />
    </div>
  );
}

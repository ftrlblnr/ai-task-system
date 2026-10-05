import type { CSSProperties, ReactNode } from 'react';
import { Square } from 'lucide-react';
import { Button } from './button';
import { cx } from './button';

// Порт Waveform/LiveVoiceBar — панель живого голоса (GPT-Live) над
// композером. `amp` — текущая амплитуда 0..1; без неё (`amp == null`) —
// мягкая автоанимация (CSS `.is-auto`), не завязанная на реальный звук.
export function Waveform({ amp, bars = 5 }: { amp?: number | null; bars?: number }) {
  const ks = [0.5, 0.8, 1, 0.7, 0.45, 0.9, 0.6];
  return (
    <span className={cx('ds-wave', amp == null && 'is-auto')} style={amp != null ? ({ '--amp': amp } as CSSProperties) : undefined}>
      {Array.from({ length: bars }).map((_, i) => (
        <i key={i} style={{ '--k': ks[i % ks.length] } as CSSProperties} />
      ))}
    </span>
  );
}

interface LiveVoiceBarProps {
  status: ReactNode;
  caption?: ReactNode;
  amp?: number | null;
  onStop: () => void;
  stopDisabled?: boolean;
}

export function LiveVoiceBar({ status, caption, amp, onStop, stopDisabled }: LiveVoiceBarProps) {
  return (
    <div className="ds-live" role="status">
      <Waveform amp={amp} />
      <span className="ds-live-status">{status}</span>
      <span className="ds-live-caption">{caption}</span>
      <Button size="sm" variant="secondary" icon={Square} onClick={onStop} disabled={stopDisabled}>
        Завершить
      </Button>
    </div>
  );
}

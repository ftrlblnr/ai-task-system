import { cx } from './button';

// Плитка-счётчик «Сегодня» (§4.2): число крупно, подпись мелко; нажатие
// ведёт в раздел. accent — «просрочено», единственная плитка с заливкой,
// чтобы взгляд цеплялся за неё первой.
export function StatTile({ value, label, accent, onClick }: { value: number | string; label: string; accent?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={cx('stat-tile', accent && 'is-accent')} onClick={onClick} disabled={!onClick}>
      <span className="stat-tile-value">{value}</span>
      <span className="stat-tile-label">{label}</span>
    </button>
  );
}

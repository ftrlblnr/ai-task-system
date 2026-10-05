// Порт SegmentedControl — переключатель 2–5 взаимоисключающих значений,
// бегунок едет за dur-base (SegmentedControl/README.md). Для статуса задачи
// исполнителем — передавайте только разрешённые опции как disabled.

interface SegmentedOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange?: (value: string) => void;
  label?: string;
}

export function SegmentedControl({ options, value, onChange, label }: SegmentedControlProps) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className="ds-seg" role="group" aria-label={label}>
      <span
        className="ds-seg-thumb"
        style={{ width: `calc((100% - 6px) / ${options.length})`, transform: `translateX(${idx * 100}%)` }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="ds-seg-btn"
          aria-pressed={o.value === value}
          disabled={o.disabled}
          onClick={() => onChange?.(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

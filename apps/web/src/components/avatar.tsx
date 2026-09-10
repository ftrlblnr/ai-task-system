// Палитра инициал-аватаров — заметно отличается от акцента интерфейса,
// чтобы люди визуально не путались с UI-элементами. Цвет детерминирован
// именем, чтобы один и тот же человек выглядел одинаково на всех экранах.
const PALETTE = [
  '#2C6E7F', // teal (accent family)
  '#8A5CBB', // violet
  '#C0653E', // terracotta
  '#3E7D52', // green
  '#A6862C', // ochre
  '#4A6FB0', // blue
  '#B0456F', // magenta
  '#5C7A4A', // olive
];

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const color = PALETTE[hashName(name) % PALETTE.length];
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        minWidth: size,
        background: color,
        fontSize: size * 0.4,
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

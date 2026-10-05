// Дизайн-система «Адъютант» (владелец 04.10.2026, шаг 4) — порт на классы
// .ds-avatar-t0..t5 из ds.css (project/components/Avatar/README.md: тон
// стабилен для имени) вместо инлайновой палитры. Проп-контракт (`name`,
// `size`) не меняется — так все существующие вызовы `<Avatar .../>`
// продолжают работать без правок.

function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className={`ds-avatar ds-avatar-t${hash(name) % 6}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ names = [], size = 24, max = 4 }: { names: string[]; size?: number; max?: number }) {
  const shown = names.slice(0, max);
  return (
    <span className="ds-avatar-stack">
      {shown.map((n) => (
        <Avatar key={n} name={n} size={size} />
      ))}
      {names.length > max && (
        <span className="ds-avatar ds-avatar-t5" style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}>
          +{names.length - max}
        </span>
      )}
    </span>
  );
}

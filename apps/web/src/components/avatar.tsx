'use client';

import { useState } from 'react';
import { apiUrl } from '@/lib/api';
import { useAvatars } from '@/lib/avatars';

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

// id — сотрудник: если он загрузил фото (владелец 22.10.2026), показываем
// его вместо инициалов; не загрузилось — снова инициалы.
export function Avatar({ name, size = 28, id }: { name: string; size?: number; id?: string }) {
  const { urls } = useAvatars();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const photo = id ? urls[id] : undefined;
  if (photo && photo !== failedUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- маленькая картинка с API, next/image тут не нужен
      <img
        src={apiUrl(photo)}
        alt={name}
        title={name}
        className="ds-avatar"
        style={{ width: size, height: size, objectFit: 'cover', padding: 0 }}
        onError={() => setFailedUrl(photo)}
      />
    );
  }
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

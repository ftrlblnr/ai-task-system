'use client';

import { useState, type ChangeEvent } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { squareAvatar, useAvatars } from '@/lib/avatars';
import { Button } from '@/components/ui/button';
import { Avatar } from './avatar';

// Своё фото (владелец 22.10.2026): выбрать картинку — браузер обрезает её
// до квадрата 256×256 и отправляет PUT /me/avatar.
// showAvatar=false — только кнопки (картинку уже показывает шапка профиля).
export function AvatarEditor({ employeeId, name, size = 72, showAvatar = true }: { employeeId: string; name: string; size?: number; showAvatar?: boolean }) {
  const { urls, setOwn } = useAvatars();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasPhoto = Boolean(urls[employeeId]);

  async function onPicked(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', await squareAvatar(file), 'avatar.jpg');
      const { photoUrl } = await api.putForm<{ photoUrl: string }>('/me/avatar', formData);
      setOwn(employeeId, photoUrl);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Не удалось загрузить фото');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.delete('/me/avatar');
      setOwn(employeeId, null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить фото');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      {showAvatar && <Avatar id={employeeId} name={name} size={size} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <label className="ds-btn ds-btn-secondary ds-btn-sm" style={{ display: 'inline-flex', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
            <Camera size={16} strokeWidth={1.75} />
            {busy ? 'Сохраняю…' : hasPhoto ? 'Сменить фото' : 'Загрузить фото'}
            <input type="file" hidden accept="image/jpeg,image/png,image/webp,image/heic" disabled={busy} onChange={onPicked} />
          </label>
          {hasPhoto && (
            <Button size="sm" variant="ghost" icon={Trash2} onClick={remove} disabled={busy}>
              Удалить
            </Button>
          )}
        </div>
        {error && <span className="ds-field-hint" style={{ color: 'var(--danger)' }}>{error}</span>}
      </div>
    </div>
  );
}

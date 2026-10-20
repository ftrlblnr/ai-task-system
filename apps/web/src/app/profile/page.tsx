'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { Direction, EmployeeDetail, Position } from '@ai-task-system/shared-types';
import { ROLE_LABELS } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Protected } from '@/components/protected';
import { Avatar } from '@/components/avatar';
import { Card, PageHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

const NEW_ITEM_VALUE = '__new__';

// «Мой профиль» (владелец 20.10.2026) — любой пользователь правит свои ФИО,
// должность и направление (может завести новые) и меняет пароль. Роль,
// статус и логин — только руководство на карточке сотрудника. Фото пока
// нет: загрузки аватаров в системе нет, Avatar рисует инициалы.
function ProfileForm({ me, onSaved }: { me: EmployeeDetail; onSaved: (next: EmployeeDetail) => void }) {
  const { updateUser } = useAuth();
  const [positions, setPositions] = useState<Position[]>([]);
  const [directions, setDirections] = useState<Direction[]>([]);
  const [fullName, setFullName] = useState(me.fullName);
  const [positionId, setPositionId] = useState(me.positionId ?? '');
  const [newPositionTitle, setNewPositionTitle] = useState('');
  const [directionId, setDirectionId] = useState(me.directionId ?? '');
  const [newDirectionTitle, setNewDirectionTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<Position[]>('/positions').then(setPositions).catch(() => {});
    api.get<Direction[]>('/directions').then(setDirections).catch(() => {});
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      let finalPositionId: string | null = positionId || null;
      if (positionId === NEW_ITEM_VALUE) {
        const created = await api.post<Position>('/positions', { title: newPositionTitle.trim() });
        setPositions((list) => [...list, created]);
        setPositionId(created.id);
        setNewPositionTitle('');
        finalPositionId = created.id;
      }
      let finalDirectionId: string | null = directionId || null;
      if (directionId === NEW_ITEM_VALUE) {
        const created = await api.post<Direction>('/directions', { title: newDirectionTitle.trim() });
        setDirections((list) => [...list, created]);
        setDirectionId(created.id);
        setNewDirectionTitle('');
        finalDirectionId = created.id;
      }
      const next = await api.patch<EmployeeDetail>('/me', { fullName: fullName.trim(), positionId: finalPositionId, directionId: finalDirectionId });
      updateUser({ fullName: next.fullName });
      onSaved(next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить профиль');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Данные" style={{ maxWidth: 520, marginBottom: 20 }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="ФИО">
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </Field>

        <Field label="Должность">
          <Select
            value={positionId}
            onChange={(e) => setPositionId(e.target.value)}
            options={[{ value: '', label: '—' }, ...positions.map((p) => ({ value: p.id, label: p.title })), { value: NEW_ITEM_VALUE, label: '+ Новая должность…' }]}
          />
        </Field>
        {positionId === NEW_ITEM_VALUE && (
          <Field label="Название новой должности">
            <Input value={newPositionTitle} onChange={(e) => setNewPositionTitle(e.target.value)} required />
          </Field>
        )}

        <Field label="Направление">
          <Select
            value={directionId}
            onChange={(e) => setDirectionId(e.target.value)}
            options={[{ value: '', label: '—' }, ...directions.map((d) => ({ value: d.id, label: d.title })), { value: NEW_ITEM_VALUE, label: '+ Новое направление…' }]}
          />
        </Field>
        {directionId === NEW_ITEM_VALUE && (
          <Field label="Название нового направления">
            <Input value={newDirectionTitle} onChange={(e) => setNewDirectionTitle(e.target.value)} required />
          </Field>
        )}

        {error && <Alert tone="danger">{error}</Alert>}
        {saved && <Alert tone="ok">Сохранено</Alert>}
        <Button type="submit" variant="primary" disabled={busy} loading={busy}>
          Сохранить
        </Button>
      </form>
    </Card>
  );
}

function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await api.post('/me/password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сменить пароль');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Пароль" style={{ maxWidth: 520 }}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Текущий пароль">
          <Input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        </Field>
        <Field label="Новый пароль" hint="Не короче 8 символов">
          <Input type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        {saved && <Alert tone="ok">Пароль изменён</Alert>}
        <Button type="submit" variant="primary" disabled={busy} loading={busy}>
          Сменить пароль
        </Button>
      </form>
    </Card>
  );
}

function ProfileView() {
  const [me, setMe] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<EmployeeDetail>('/me')
      .then(setMe)
      .catch(() => setError('Не удалось загрузить профиль'));
  }, []);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!me) return <p className="ds-field-hint">Загрузка…</p>;

  return (
    <>
      <div className="profile-head">
        <Avatar name={me.fullName} size={52} />
        <div>
          <h1>{me.fullName}</h1>
          <p className="ds-field-hint">
            {ROLE_LABELS[me.role]} · {me.email}
          </p>
        </div>
      </div>
      <ProfileForm me={me} onSaved={setMe} />
      <PasswordForm />
    </>
  );
}

export default function ProfilePage() {
  return (
    <Protected>
      <PageHeader title="Мой профиль" />
      <ProfileView />
    </Protected>
  );
}

'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { Direction, EmployeeDetail, Position } from '@ai-task-system/shared-types';
import { ROLE_LABELS } from '@ai-task-system/shared-types';
import { api, apiUrl, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Protected } from '@/components/protected';
import { Avatar } from '@/components/avatar';
import { AvatarEditor } from '@/components/avatar-editor';
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

interface Connection {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Подключение Claude по MCP (владелец 22.10.2026): адрес для «Добавить
// коннектор» и список выданных доступов с отключением. Блок виден только
// ролям, которым подключение разрешено (MCP_ROLES).
function ConnectionsCard() {
  const [state, setState] = useState<{ allowed: boolean; items: Connection[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const url = apiUrl('/mcp');

  function load() {
    api
      .get<{ enabled: boolean; allowed: boolean; items: Connection[] }>('/oauth/connections')
      .then((res) => setState({ allowed: res.enabled && res.allowed, items: res.items }))
      .catch(() => setState(null));
  }
  useEffect(load, []);

  async function revoke(id: string) {
    await api.delete(`/oauth/connections/${id}`).catch(() => undefined);
    load();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (!state?.allowed) return null;
  return (
    <Card title="Подключённые приложения" style={{ maxWidth: 520, marginTop: 20 }}>
      <p className="ds-field-hint" style={{ marginTop: 0 }}>
        Claude может работать с Адъютантом от вашего имени: в Claude откройте «Настройки» → «Коннекторы» → «Добавить свой коннектор» и вставьте адрес:
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <code style={{ overflowWrap: 'anywhere' }}>{url}</code>
        <Button size="sm" variant="secondary" onClick={copy}>
          {copied ? 'Скопировано' : 'Копировать'}
        </Button>
      </div>
      {state.items.length === 0 ? (
        <p className="ds-field-hint">Подключений нет.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {state.items.map((c) => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <strong>{c.clientName}</strong>
                <p className="ds-field-hint" style={{ margin: 0 }}>
                  подключено {formatDate(c.createdAt)}
                  {c.lastUsedAt ? ` · последний доступ ${formatDate(c.lastUsedAt)}` : ''}
                </p>
              </div>
              <Button size="sm" variant="danger" onClick={() => revoke(c.id)}>
                Отключить
              </Button>
            </div>
          ))}
        </div>
      )}
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
        <Avatar id={me.id} name={me.fullName} size={64} />
        <div>
          <h1>{me.fullName}</h1>
          <p className="ds-field-hint">
            {ROLE_LABELS[me.role]} · {me.email}
          </p>
          <AvatarEditor employeeId={me.id} name={me.fullName} showAvatar={false} />
        </div>
      </div>
      <ProfileForm me={me} onSaved={setMe} />
      <PasswordForm />
      <ConnectionsCard />
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

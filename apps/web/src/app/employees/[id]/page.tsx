'use client';

import { use, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { Direction, EmployeeDetail, PasswordResetLink, TelegramInvite } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Avatar } from '@/components/avatar';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input, Textarea, Select } from '@/components/ui/field';

const NEW_ITEM_VALUE = '__new__';

interface CatalogItem {
  id: string;
  name: string;
  description: string;
}

// Форма добавления компетенции: выбор из каталога либо создание нового
// элемента на лету (раздел 6.4 ТЗ — развёрнутое описание, не тег).
function AttachCatalogItemForm({
  catalogEndpoint,
  attachPath,
  itemIdField,
  itemLabel,
  onAdded,
}: {
  catalogEndpoint: string;
  attachPath: string;
  itemIdField: 'competencyId';
  itemLabel: string;
  onAdded: () => void;
}) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [itemId, setItemId] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<CatalogItem[]>(catalogEndpoint).then(setCatalog).catch(() => {});
  }, [catalogEndpoint]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!itemId) {
      setError(`Выберите ${itemLabel}`);
      return;
    }
    if (itemId === NEW_ITEM_VALUE && (!newName.trim() || newDescription.trim().length < 20)) {
      setError('Укажите название и развёрнутое описание (от 20 символов)');
      return;
    }

    setBusy(true);
    try {
      let finalId = itemId;
      if (itemId === NEW_ITEM_VALUE) {
        const created = await api.post<CatalogItem>(catalogEndpoint, {
          name: newName.trim(),
          description: newDescription.trim(),
        });
        finalId = created.id;
        setCatalog((prev) => [...prev, created]);
      }

      await api.post(attachPath, { [itemIdField]: finalId, description: note.trim() || undefined });

      setItemId('');
      setNewName('');
      setNewDescription('');
      setNote('');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="attach-form" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Select
        value={itemId}
        onChange={(e) => setItemId(e.target.value)}
        options={[
          { value: '', label: `Выбрать ${itemLabel}…` },
          ...catalog.map((item) => ({ value: item.id, label: item.name })),
          { value: NEW_ITEM_VALUE, label: '+ Новое…' },
        ]}
      />

      {itemId === NEW_ITEM_VALUE && (
        <>
          <Input placeholder="Название" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Textarea
            placeholder="Развёрнутое описание (не тег — раздел 6.4 ТЗ: точность зависит от содержательности)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            rows={2}
          />
        </>
      )}

      {itemId && itemId !== NEW_ITEM_VALUE && (
        <Textarea
          placeholder="Уточнение именно для этого сотрудника (необязательно)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <Button type="submit" disabled={busy} loading={busy}>
        Добавить
      </Button>
    </form>
  );
}

function TelegramSection({ employee, onChange }: { employee: EmployeeDetail; onChange: () => void }) {
  const [invite, setInvite] = useState<TelegramInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function createInvite() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<TelegramInvite>(`/employees/${employee.id}/telegram-invite`);
      setInvite(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать приглашение');
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/employees/${employee.id}/telegram-link`);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отвязать Telegram');
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (employee.telegramId) {
    return (
      <Card title="Telegram">
        <p>
          Привязан <Badge tone="ok">аккаунт подтверждён</Badge>
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button variant="secondary" onClick={unlink} disabled={busy}>
          Отвязать
        </Button>
      </Card>
    );
  }

  return (
    <Card title="Telegram">
      <p className="ds-field-hint">
        Не привязан. Руководитель не знает Telegram-id сотрудника заранее — сгенерируйте одноразовую
        ссылку и передайте её сотруднику лично (в личном сообщении, не публично). Ссылка открывает
        Telegram Mini App, и аккаунт привяжется сам — без ручного ввода id.
      </p>

      {!invite && (
        <Button onClick={createInvite} disabled={busy} loading={busy}>
          Сгенерировать приглашение
        </Button>
      )}

      {invite && (
        <div className="invite-box">
          {invite.deepLink ? (
            <>
              <p className="ds-field-hint">Ссылка действительна до {new Date(invite.expiresAt).toLocaleString('ru-RU')}:</p>
              <div className="input-row">
                <Input readOnly value={invite.deepLink} onFocus={(e) => e.target.select()} />
                <Button type="button" variant="secondary" onClick={() => copy(invite.deepLink!)}>
                  {copied ? 'Скопировано' : 'Копировать'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="ds-field-hint">
                Mini App пока не настроен (не заданы TELEGRAM_BOT_USERNAME /
                TELEGRAM_MINIAPP_SHORT_NAME) — передайте сотруднику токен вручную, он понадобится при
                первом открытии Mini App. Действителен до{' '}
                {new Date(invite.expiresAt).toLocaleString('ru-RU')}:
              </p>
              <div className="input-row">
                <Input readOnly value={invite.token} onFocus={(e) => e.target.select()} />
                <Button type="button" variant="secondary" onClick={() => copy(invite.token)}>
                  {copied ? 'Скопировано' : 'Копировать'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

// Владелец 08.09.2026: раньше единственный путь восстановить пароль был
// прямым вмешательством в БД. Тот же UX, что у TelegramSection выше —
// сгенерировать одноразовую ссылку и передать сотруднику лично.
function PasswordResetSection({ employeeId }: { employeeId: string }) {
  const [reset, setReset] = useState<PasswordResetLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function createReset() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<PasswordResetLink>(`/auth/employees/${employeeId}/password-reset-invite`);
      setReset(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать ссылку');
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card title="Пароль">
      <p className="ds-field-hint">
        Сотрудник забыл пароль — сгенерируйте одноразовую ссылку и передайте её лично (в личном
        сообщении, не публично). По ссылке сотрудник сам задаст новый пароль.
      </p>

      {!reset && (
        <Button variant="secondary" onClick={createReset} disabled={busy} loading={busy}>
          Сбросить пароль
        </Button>
      )}

      {reset && (
        <div className="invite-box">
          <p className="ds-field-hint">Ссылка действительна до {new Date(reset.expiresAt).toLocaleString('ru-RU')}:</p>
          <div className="input-row">
            <Input readOnly value={reset.link} onFocus={(e) => e.target.select()} />
            <Button type="button" variant="secondary" onClick={() => copy(reset.link)}>
              {copied ? 'Скопировано' : 'Копировать'}
            </Button>
          </div>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

// Владелец 30.09.2026: направление (отдел, например «Маркетинг») — один на
// сотрудника, нужен для фильтрации задач по org-unit (kanban-board.tsx), не
// путать с компетенциями выше (многие-ко-многим, для AI-подбора
// исполнителя). В отличие от должности (только при создании сотрудника),
// направление можно менять и после — сохраняется сразу при выборе, без
// отдельной кнопки.
function DirectionSection({ employee, onChange }: { employee: EmployeeDetail; onChange: () => void }) {
  const [directions, setDirections] = useState<Direction[]>([]);
  const [directionId, setDirectionId] = useState(employee.directionId ?? '');
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Direction[]>('/directions').then(setDirections).catch(() => {});
  }, []);

  async function save(nextDirectionId: string) {
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/employees/${employee.id}`, { directionId: nextDirectionId || null });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить направление');
    } finally {
      setBusy(false);
    }
  }

  async function handleSelect(value: string) {
    setDirectionId(value);
    if (value !== NEW_ITEM_VALUE) await save(value);
  }

  async function createAndSave(e: FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const created = await api.post<Direction>('/directions', { title: newTitle.trim() });
      setNewTitle('');
      setDirectionId(created.id);
      await save(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать направление');
      setBusy(false);
    }
  }

  return (
    <Card title="Направление">
      <Select
        value={directionId}
        onChange={(e) => handleSelect(e.target.value)}
        disabled={busy}
        options={[{ value: '', label: '—' }, ...directions.map((d) => ({ value: d.id, label: d.title })), { value: NEW_ITEM_VALUE, label: '+ Новое направление…' }]}
      />
      {directionId === NEW_ITEM_VALUE && (
        <form onSubmit={createAndSave} className="input-row" style={{ marginTop: 8 }}>
          <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Название направления" required />
          <Button type="submit" variant="secondary" disabled={busy} loading={busy}>
            Создать
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

function EmployeeDetailView({ id }: { id: string }) {
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function load() {
    api
      .get<EmployeeDetail>(`/employees/${id}`)
      .then(setEmployee)
      .catch(() => setError('Не удалось загрузить сотрудника'));
  }

  useEffect(load, [id]);

  async function removeCompetency(competencyId: string) {
    setActionError(null);
    try {
      await api.delete(`/employees/${id}/competencies/${competencyId}`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Не удалось удалить компетенцию');
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!employee) return <p className="ds-field-hint">Загрузка…</p>;

  return (
    <div>
      <Link href="/employees" className="back-link">
        <ArrowLeft size={14} strokeWidth={1.75} />
        Сотрудники
      </Link>
      <div className="profile-head">
        <Avatar name={employee.fullName} size={52} />
        <div>
          <h1>{employee.fullName}</h1>
          <div className="task-meta">
            <Badge>{employee.position?.title ?? 'Должность не указана'}</Badge>
            <Badge>{employee.role === 'OWNER' ? 'Руководитель' : 'Подчинённый'}</Badge>
            <Badge>{employee.email}</Badge>
            {employee.isProfileAdmin && <Badge>Администратор профилей</Badge>}
          </div>
        </div>
      </div>

      {actionError && <Alert tone="danger">{actionError}</Alert>}

      <Card title="Компетенции">
        {employee.competencies.length === 0 && <p className="ds-field-hint">Пока не заведены.</p>}
        <ul className="plain-list">
          {employee.competencies.map((c) => (
            <li key={c.competency.id} className="plain-list-row">
              <div>
                <strong>{c.competency.name}</strong>
                {c.description && <p className="ds-field-hint">{c.description}</p>}
              </div>
              <Button variant="secondary" size="sm" onClick={() => removeCompetency(c.competency.id)}>
                Удалить
              </Button>
            </li>
          ))}
        </ul>
        <AttachCatalogItemForm
          catalogEndpoint="/competencies"
          attachPath={`/employees/${employee.id}/competencies`}
          itemIdField="competencyId"
          itemLabel="компетенцию"
          onAdded={load}
        />
      </Card>

      <DirectionSection employee={employee} onChange={load} />

      <TelegramSection employee={employee} onChange={load} />
      <PasswordResetSection employeeId={employee.id} />
    </div>
  );
}

export default function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Protected requireRole="OWNER">
      <EmployeeDetailView id={id} />
    </Protected>
  );
}

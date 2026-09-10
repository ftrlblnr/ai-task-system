'use client';

import { use, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { EmployeeDetail, PasswordResetLink, TelegramInvite } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Avatar } from '@/components/avatar';

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
    <form onSubmit={handleSubmit} className="attach-form">
      <select value={itemId} onChange={(e) => setItemId(e.target.value)}>
        <option value="">Выбрать {itemLabel}…</option>
        {catalog.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
        <option value={NEW_ITEM_VALUE}>+ Новое…</option>
      </select>

      {itemId === NEW_ITEM_VALUE && (
        <>
          <input
            placeholder="Название"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <textarea
            placeholder="Развёрнутое описание (не тег — раздел 6.4 ТЗ: точность зависит от содержательности)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            rows={2}
          />
        </>
      )}

      {itemId && itemId !== NEW_ITEM_VALUE && (
        <textarea
          placeholder="Уточнение именно для этого сотрудника (необязательно)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />
      )}

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={busy}>
        {busy ? 'Добавляем…' : 'Добавить'}
      </button>
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
      <div className="card">
        <h2>Telegram</h2>
        <p>
          Привязан <span className="badge status-done">аккаунт подтверждён</span>
        </p>
        {error && <p className="error">{error}</p>}
        <button className="btn-secondary" onClick={unlink} disabled={busy}>
          Отвязать
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Telegram</h2>
      <p className="hint">
        Не привязан. Руководитель не знает Telegram-id сотрудника заранее — сгенерируйте одноразовую
        ссылку и передайте её сотруднику лично (в личном сообщении, не публично). Ссылка открывает
        Telegram Mini App, и аккаунт привяжется сам — без ручного ввода id.
      </p>

      {!invite && (
        <button onClick={createInvite} disabled={busy}>
          {busy ? 'Создаём…' : 'Сгенерировать приглашение'}
        </button>
      )}

      {invite && (
        <div className="invite-box">
          {invite.deepLink ? (
            <>
              <p className="hint">Ссылка действительна до {new Date(invite.expiresAt).toLocaleString('ru-RU')}:</p>
              <div className="input-row">
                <input readOnly value={invite.deepLink} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn-secondary" onClick={() => copy(invite.deepLink!)}>
                  {copied ? 'Скопировано' : 'Копировать'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="hint">
                Mini App пока не настроен (не заданы TELEGRAM_BOT_USERNAME /
                TELEGRAM_MINIAPP_SHORT_NAME) — передайте сотруднику токен вручную, он понадобится при
                первом открытии Mini App. Действителен до{' '}
                {new Date(invite.expiresAt).toLocaleString('ru-RU')}:
              </p>
              <div className="input-row">
                <input readOnly value={invite.token} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn-secondary" onClick={() => copy(invite.token)}>
                  {copied ? 'Скопировано' : 'Копировать'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
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
    <div className="card">
      <h2>Пароль</h2>
      <p className="hint">
        Сотрудник забыл пароль — сгенерируйте одноразовую ссылку и передайте её лично (в личном
        сообщении, не публично). По ссылке сотрудник сам задаст новый пароль.
      </p>

      {!reset && (
        <button className="btn-secondary" onClick={createReset} disabled={busy}>
          {busy ? 'Создаём…' : 'Сбросить пароль'}
        </button>
      )}

      {reset && (
        <div className="invite-box">
          <p className="hint">Ссылка действительна до {new Date(reset.expiresAt).toLocaleString('ru-RU')}:</p>
          <div className="input-row">
            <input readOnly value={reset.link} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn-secondary" onClick={() => copy(reset.link)}>
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
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

  if (error) return <p className="error">{error}</p>;
  if (!employee) return <p className="hint">Загрузка…</p>;

  return (
    <div>
      <Link href="/employees" className="back-link">
        <ArrowLeft size={14} strokeWidth={2.25} />
        Сотрудники
      </Link>
      <div className="profile-head">
        <Avatar name={employee.fullName} size={52} />
        <div>
          <h1>{employee.fullName}</h1>
          <div className="task-meta">
            <span className="badge badge-muted">{employee.position?.title ?? 'Должность не указана'}</span>
            <span className="badge badge-muted">{employee.role === 'OWNER' ? 'Руководитель' : 'Подчинённый'}</span>
            <span className="badge badge-muted">{employee.email}</span>
            {employee.isProfileAdmin && <span className="badge badge-muted">Администратор профилей</span>}
          </div>
        </div>
      </div>

      {actionError && <p className="error">{actionError}</p>}

      <div className="card">
        <h2>Компетенции</h2>
        {employee.competencies.length === 0 && <p className="hint">Пока не заведены.</p>}
        <ul className="plain-list">
          {employee.competencies.map((c) => (
            <li key={c.competency.id} className="plain-list-row">
              <div>
                <strong>{c.competency.name}</strong>
                {c.description && <p className="hint">{c.description}</p>}
              </div>
              <button
                type="button"
                className="btn-secondary btn-small"
                onClick={() => removeCompetency(c.competency.id)}
              >
                Удалить
              </button>
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
      </div>

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

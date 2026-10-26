'use client';

import { use, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, Compass, KeyRound, Plus, Send, Shield, Award, Trash2 } from 'lucide-react';
import type { Direction, EmployeeDetail, PasswordResetLink, Role, TelegramInvite } from '@ai-task-system/shared-types';
import { MANAGER_ROLES, ROLE_LABELS } from '@ai-task-system/shared-types';
import { useAuth } from '@/lib/auth-context';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Avatar } from '@/components/avatar';
import { PageHeader } from '@/components/ui/card';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Panel, StatusTag } from '@/components/ui/panel';
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
    <form onSubmit={handleSubmit} className="attach-form">
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
            placeholder="Развёрнутое описание — по нему агент подбирает исполнителя"
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

      <Button type="submit" variant="secondary" size="sm" icon={Plus} disabled={busy} loading={busy}>
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
      <Panel icon={Send} title="Telegram" aside={<StatusTag tone="ok">привязан</StatusTag>}>
        <p className="panel-hint">Аккаунт подтверждён — задачи и напоминания приходят в Telegram.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="panel-actions">
          <Button variant="secondary" size="sm" onClick={unlink} disabled={busy}>
            Отвязать
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel icon={Send} title="Telegram" aside={<StatusTag tone="muted">не привязан</StatusTag>}>
      <p className="panel-hint">Одноразовая ссылка привяжет аккаунт сама — передайте её сотруднику лично.</p>

      {!invite && (
        <div className="panel-actions">
          <Button variant="secondary" size="sm" onClick={createInvite} disabled={busy} loading={busy}>
            Создать приглашение
          </Button>
        </div>
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
    </Panel>
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
    <Panel icon={KeyRound} title="Пароль">
      <p className="panel-hint">Забыл пароль — одноразовая ссылка, по ней сотрудник задаст новый. Передайте лично.</p>

      {!reset && (
        <div className="panel-actions">
          <Button variant="secondary" size="sm" onClick={createReset} disabled={busy} loading={busy}>
            Сбросить пароль
          </Button>
        </div>
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
    </Panel>
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
    <Panel icon={Compass} title="Направление">
      <Select
        value={directionId}
        onChange={(e) => handleSelect(e.target.value)}
        disabled={busy}
        options={[{ value: '', label: '—' }, ...directions.map((d) => ({ value: d.id, label: d.title })), { value: NEW_ITEM_VALUE, label: '+ Новое направление…' }]}
      />
      {directionId === NEW_ITEM_VALUE && (
        <form onSubmit={createAndSave} className="input-row">
          <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Название направления" required />
          <Button type="submit" variant="secondary" disabled={busy} loading={busy}>
            Создать
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Panel>
  );
}

// Ролевая модель 20.10.2026: назначать и снимать администратора может
// только руководитель; её собственную роль здесь не меняют.
function RoleSection({ employee, onChange }: { employee: EmployeeDetail; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(role: Role) {
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/employees/${employee.id}`, { role });
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сменить роль');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel icon={Shield} title="Роль">
      <Select
        value={employee.role}
        onChange={(e) => save(e.target.value as Role)}
        disabled={busy}
        options={[
          { value: 'EMPLOYEE', label: ROLE_LABELS.EMPLOYEE },
          { value: 'ADMIN', label: ROLE_LABELS.ADMIN },
        ]}
      />
      {error && <Alert tone="danger">{error}</Alert>}
    </Panel>
  );
}

function EmployeeDetailView({ id }: { id: string }) {
  const { user } = useAuth();
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
      <PageHeader
        kicker={`${employee.position?.title ?? 'Должность не указана'} · ${ROLE_LABELS[employee.role]}`}
        title={
          <span className="pagehead-person">
            <Avatar id={employee.id} name={employee.fullName} size={40} />
            {employee.fullName}
          </span>
        }
        description={employee.email}
      />

      {actionError && <Alert tone="danger">{actionError}</Alert>}

      <div className="detail-grid">
        <Panel icon={Award} title="Компетенции">
          {employee.competencies.length === 0 ? (
            <p className="panel-hint">Пока не заведены — по ним агент подбирает исполнителя.</p>
          ) : (
            <ul className="row-list">
              {employee.competencies.map((c) => (
                <li key={c.competency.id} className="row-item">
                  <div className="row-item-main">
                    <div className="row-item-title">{c.competency.name}</div>
                    {c.description && <p className="row-item-meta">{c.description}</p>}
                  </div>
                  <IconButton icon={Trash2} label={`Удалить «${c.competency.name}»`} size="sm" variant="ghost" onClick={() => removeCompetency(c.competency.id)} />
                </li>
              ))}
            </ul>
          )}
          <AttachCatalogItemForm
            catalogEndpoint="/competencies"
            attachPath={`/employees/${employee.id}/competencies`}
            itemIdField="competencyId"
            itemLabel="компетенцию"
            onAdded={load}
          />
        </Panel>

        {/* Учётку руководителя (направление, Telegram, пароль) администратор
            не меняет — API ответит 403, поэтому разделы просто не показываем. */}
        {(employee.role !== 'OWNER' || user?.role === 'OWNER') && (
          <div className="detail-col">
            {user?.role === 'OWNER' && employee.role !== 'OWNER' && <RoleSection employee={employee} onChange={load} />}
            <DirectionSection employee={employee} onChange={load} />
            <TelegramSection employee={employee} onChange={load} />
            <PasswordResetSection employeeId={employee.id} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <EmployeeDetailView id={id} />
    </Protected>
  );
}

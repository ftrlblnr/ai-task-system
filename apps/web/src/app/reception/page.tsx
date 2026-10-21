'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  CreateReceptionRequestInput,
  EditReceptionRequestInput,
  EmployeeSummary,
  ReceptionListResponse,
  ReceptionRequestItem,
  ReceptionRequestStatus,
  ReceptionRequestType,
} from '@ai-task-system/shared-types';
import { isManagerRole } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Protected } from '@/components/protected';
import { ReceptionBoard } from '@/components/reception-board';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { Field, Input, Textarea, Select } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';

// ТЗ «Приёмная руководителя» v1.0 (02.10.2026). Polling 5с, пока экран
// открыт/виден (раздел 10.3 ТЗ) — применяется к очереди OWNER и к активным
// обращениям сотрудника (там нужна свежесть "вас вызывают"), НЕ к истории
// (статична, листается по клику).
const POLL_MS = 5_000;

const REQUEST_TYPE_LABELS: Record<ReceptionRequestType, string> = {
  DECISION: 'Решение',
  APPROVAL: 'Согласование',
  DISCUSSION: 'Обсуждение',
  HELP: 'Помощь',
};

const STATUS_LABELS: Record<ReceptionRequestStatus, string> = {
  WAITING: 'Ожидает',
  CALLED: 'Вызван',
  COMPLETED: 'Обсуждено',
  ANSWERED: 'Отвечено',
  DELEGATED: 'Разберитесь сами',
  REJECTED: 'Отклонено',
  WITHDRAWN: 'Отозвано',
};

const STATUS_BADGE_TONE: Record<ReceptionRequestStatus, BadgeTone> = {
  WAITING: 'neutral',
  CALLED: 'warn',
  COMPLETED: 'ok',
  ANSWERED: 'ok',
  DELEGATED: 'info',
  REJECTED: 'danger',
  WITHDRAWN: 'neutral',
};

const EXPECTED_MINUTES_OPTIONS = [5, 10, 15, 30];

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

function isExpired(desiredBy: string | null): boolean {
  return Boolean(desiredBy && new Date(desiredBy).getTime() < Date.now());
}

// Каждое мутирующее действие — свой Idempotency-Key (раздел 12 ТЗ),
// сгенерированный ОДИН раз и переиспользуемый при повторе того же действия
// (раздел 8.2 ТЗ — "повтор отправки использует прежний ключ"); сбрасывается
// на новый после успеха и после ответа сервера с 4xx: сервер запоминает
// ошибку под ключом, а пользователь исправит форму — тело будет другим, и
// старый ключ дал бы IDEMPOTENCY_CONFLICT (прод 21.10.2026).
function useIdempotencyKey(): { key: () => string; reset: () => void } {
  const ref = useRef<string | null>(null);
  return {
    key: () => {
      if (!ref.current) ref.current = crypto.randomUUID();
      return ref.current;
    },
    reset: () => {
      ref.current = null;
    },
  };
}

function useVisiblePolling(fn: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') fn();
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fn пересоздаётся каждый рендер, интервал должен жить своим циклом, не пересоздаваться на каждый тик
  }, [enabled]);
}

// --- форма подачи/редактирования обращения (раздел 8.2 ТЗ) ---

interface RequestFormValue {
  title: string;
  description: string;
  requestType: ReceptionRequestType;
  expectedMinutes: string;
  desiredBy: string;
  urgencyReason: string;
}

function emptyFormValue(): RequestFormValue {
  return { title: '', description: '', requestType: 'DISCUSSION', expectedMinutes: '', desiredBy: '', urgencyReason: '' };
}

function fromRequest(r: ReceptionRequestItem): RequestFormValue {
  return {
    title: r.title,
    description: r.description,
    requestType: r.requestType,
    expectedMinutes: r.expectedMinutes ? String(r.expectedMinutes) : '',
    // datetime-local не принимает Z-суффикс/секунды — обрезаем до минут.
    desiredBy: r.desiredBy ? r.desiredBy.slice(0, 16) : '',
    urgencyReason: r.urgencyReason ?? '',
  };
}

function RequestForm({
  editing,
  onCancel,
  onSaved,
}: {
  editing: ReceptionRequestItem | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState<RequestFormValue>(() => (editing ? fromRequest(editing) : emptyFormValue()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (value.desiredBy && !value.urgencyReason.trim()) {
      setError('При указании срока укажите причину срочности');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const payload: CreateReceptionRequestInput = {
        title: value.title.trim(),
        description: value.description.trim(),
        requestType: value.requestType,
        expectedMinutes: value.expectedMinutes ? Number(value.expectedMinutes) : undefined,
        desiredBy: value.desiredBy ? new Date(value.desiredBy).toISOString() : undefined,
        urgencyReason: value.desiredBy ? value.urgencyReason.trim() : undefined,
      };
      const headers = { 'Idempotency-Key': idem.key() };
      if (editing) {
        const editPayload: EditReceptionRequestInput = { ...payload, version: editing.version };
        await api.patch(`/reception/requests/${editing.id}`, editPayload, headers);
      } else {
        await api.post('/reception/requests', payload, headers);
      }
      idem.reset();
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) idem.reset();
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить обращение');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="ds-card" style={{ marginBottom: 16, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h2 style={{ marginBottom: 8 }}>{editing ? 'Изменить обращение' : 'Подать вопрос'}</h2>
      <Field label="Тема">
        <Input value={value.title} onChange={(e) => setValue({ ...value, title: e.target.value })} minLength={5} maxLength={150} required />
      </Field>
      <Field label="Описание вопроса">
        <Textarea
          value={value.description}
          onChange={(e) => setValue({ ...value, description: e.target.value })}
          minLength={10}
          maxLength={3000}
          rows={4}
          required
        />
      </Field>
      <Field label="Что требуется">
        <Select
          value={value.requestType}
          onChange={(e) => setValue({ ...value, requestType: e.target.value as ReceptionRequestType })}
          options={Object.entries(REQUEST_TYPE_LABELS).map(([k, label]) => ({ value: k, label }))}
        />
      </Field>
      <Field label="Ожидаемая длительность">
        <Select
          value={value.expectedMinutes}
          onChange={(e) => setValue({ ...value, expectedMinutes: e.target.value })}
          options={[{ value: '', label: 'Не указано' }, ...EXPECTED_MINUTES_OPTIONS.map((m) => ({ value: String(m), label: `${m} мин` }))]}
        />
      </Field>
      <Field label="Нужен ответ до (необязательно)">
        <Input type="datetime-local" value={value.desiredBy} onChange={(e) => setValue({ ...value, desiredBy: e.target.value })} />
      </Field>
      {value.desiredBy && (
        <Field label="Причина срочности">
          <Input
            value={value.urgencyReason}
            onChange={(e) => setValue({ ...value, urgencyReason: e.target.value })}
            minLength={5}
            maxLength={500}
            required
          />
        </Field>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="submit" variant="primary" disabled={busy} loading={busy}>
          {editing ? 'Сохранить' : 'Подать вопрос'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

// --- вкладка сотрудника: свои обращения ---

function MineView() {
  const [scope, setScope] = useState<'active' | 'history'>('active');
  const [data, setData] = useState<ReceptionListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState<'create' | ReceptionRequestItem | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    api
      .get<ReceptionListResponse>(`/reception/requests/mine?scope=${scope}&limit=50`)
      .then((r) => {
        if (requestId !== requestIdRef.current) return;
        setData(r);
        setError(null);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить обращения');
      });
  }, [scope]);

  useEffect(load, [load]);
  useVisiblePolling(load, scope === 'active' && !formOpen);

  async function withdraw(item: ReceptionRequestItem) {
    if (!window.confirm('Убрать вопрос из очереди?')) return;
    try {
      await api.post(`/reception/requests/${item.id}/withdraw`, { version: item.version }, { 'Idempotency-Key': crypto.randomUUID() });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отозвать обращение');
    }
  }

  return (
    <>
      {!formOpen && (
        <Button variant="primary" onClick={() => setFormOpen('create')} style={{ marginBottom: 16 }}>
          Подать вопрос
        </Button>
      )}
      {formOpen && (
        <RequestForm
          editing={formOpen === 'create' ? null : formOpen}
          onCancel={() => setFormOpen(null)}
          onSaved={() => {
            setFormOpen(null);
            setScope('active');
            load();
          }}
        />
      )}

      <div style={{ marginBottom: 12 }}>
        <SegmentedControl
          options={[
            { value: 'active', label: 'Активные' },
            { value: 'history', label: 'История' },
          ]}
          value={scope}
          onChange={(v) => setScope(v as 'active' | 'history')}
        />
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <p className="ds-field-hint">Загрузка…</p>}
      {data && data.items.length === 0 && (
        <EmptyState title={scope === 'active' ? 'Активных обращений нет' : 'История пуста'} />
      )}
      {data && data.items.length > 0 && (
        <ul className="plain-list">
          {data.items.map((item) => (
            <li key={item.id} className="plain-list-row" style={{ alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{item.title}</strong>
                  <Badge tone={STATUS_BADGE_TONE[item.status]}>{item.status === 'CALLED' ? 'Вас вызывают' : STATUS_LABELS[item.status]}</Badge>
                  {isExpired(item.desiredBy) && item.status === 'WAITING' && <Badge tone="warn">Запрошенный срок истёк</Badge>}
                </div>
                <p className="ds-field-hint" style={{ marginTop: 4 }}>
                  {REQUEST_TYPE_LABELS[item.requestType]} · подано {formatDateTime(item.createdAt)}
                  {item.desiredBy && <> · нужен ответ до {formatDateTime(item.desiredBy)}</>}
                </p>
                {item.status === 'REJECTED' && item.rejectionReason && <p className="ds-field-hint">Причина: {item.rejectionReason}</p>}
                {item.status === 'COMPLETED' && item.resolution && <p className="ds-field-hint">Результат: {item.resolution}</p>}
                {item.status === 'ANSWERED' && item.resolution && <p style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>Ответ: {item.resolution}</p>}
                {item.status === 'DELEGATED' && item.resolution && <p className="ds-field-hint">Комментарий: {item.resolution}</p>}
                {item.task && <p className="ds-field-hint">Задача: {item.task.title}{item.task.dueDate && ` · до ${new Date(item.task.dueDate).toLocaleDateString('ru-RU')}`}</p>}
              </div>
              {item.status === 'WAITING' && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <Button variant="secondary" size="sm" onClick={() => setFormOpen(item)}>
                    Изменить
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => withdraw(item)}>
                    Отозвать
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// --- вкладка владельца: история ---

function HistoryView() {
  const [data, setData] = useState<ReceptionListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorId, setAuthorId] = useState('');
  const [status, setStatus] = useState('');
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);

  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => {});
  }, []);

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: '50' });
    if (authorId) params.set('authorId', authorId);
    if (status) params.set('status', status);
    api
      .get<ReceptionListResponse>(`/reception/history?${params.toString()}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить историю'));
  }, [authorId, status]);

  useEffect(load, [load]);

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Select
          value={authorId}
          onChange={(e) => setAuthorId(e.target.value)}
          options={[{ value: '', label: 'Все сотрудники' }, ...employees.map((e) => ({ value: e.id, label: e.fullName }))]}
        />
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: '', label: 'Любой статус' },
            { value: 'ANSWERED', label: 'Отвечено' },
            { value: 'COMPLETED', label: 'Обсуждено' },
            { value: 'DELEGATED', label: 'Разберитесь сами' },
            { value: 'REJECTED', label: 'Отклонено' },
            { value: 'WITHDRAWN', label: 'Отозвано' },
          ]}
        />
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <p className="ds-field-hint">Загрузка…</p>}
      {data && data.items.length === 0 && <EmptyState title="Ничего не найдено" />}
      {data && data.items.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>Сотрудник</th>
                <th>Тема</th>
                <th>Статус</th>
                <th>Закрыто</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <td>{item.author.fullName}</td>
                  <td>{item.title}</td>
                  <td>
                    <Badge tone={STATUS_BADGE_TONE[item.status]}>{STATUS_LABELS[item.status]}</Badge>
                  </td>
                  <td>{formatDateTime(item.closedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type OwnerTab = 'queue' | 'history' | 'mine';

function ReceptionView() {
  const { user } = useAuth();
  const isManager = isManagerRole(user?.role);
  const [tab, setTab] = useState<OwnerTab>('queue');

  if (!isManager) {
    return (
      <>
        <h1 style={{ marginBottom: 16 }}>Приёмная</h1>
        <MineView />
      </>
    );
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <SegmentedControl
          options={[
            { value: 'queue', label: 'Доска' },
            { value: 'history', label: 'История' },
            { value: 'mine', label: 'Мои обращения' },
          ]}
          value={tab}
          onChange={(v) => setTab(v as OwnerTab)}
        />
      </div>
      {tab === 'queue' && <ReceptionBoard />}
      {tab === 'history' && <HistoryView />}
      {tab === 'mine' && <MineView />}
    </>
  );
}

export default function ReceptionPage() {
  return (
    <Protected>
      <Suspense fallback={<p className="ds-field-hint">Загрузка…</p>}>
        <ReceptionView />
      </Suspense>
    </Protected>
  );
}

'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import type {
  CompleteReceptionRequestInput,
  CreateReceptionRequestInput,
  EditReceptionRequestInput,
  EmployeeSummary,
  ReceptionListResponse,
  ReceptionQueueView,
  ReceptionRequestItem,
  ReceptionRequestStatus,
  ReceptionRequestType,
  RejectReceptionRequestInput,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Protected } from '@/components/protected';
import { Card } from '@/components/ui/card';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { Field, Input, Textarea, Select, Checkbox } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Dialog } from '@/components/ui/dialog';

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
  REJECTED: 'Отклонено',
  WITHDRAWN: 'Отозвано',
};

const STATUS_BADGE_TONE: Record<ReceptionRequestStatus, BadgeTone> = {
  WAITING: 'neutral',
  CALLED: 'warn',
  COMPLETED: 'ok',
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
// на новый только после успеха (следующее действие — уже другое намерение).
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

// --- диалоги владельца: отказ / завершение ---

function RejectDialog({ item, onClose, onDone }: { item: ReceptionRequestItem; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const payload: RejectReceptionRequestInput = { version: item.version, reason: reason.trim() || undefined };
      await api.post(`/reception/requests/${item.id}/reject`, payload, { 'Idempotency-Key': idem.key() });
      idem.reset();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отклонить обращение');
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Отказать «${item.title}»`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Назад
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy} loading={busy}>
            Отказать
          </Button>
        </>
      }
    >
      <Field label="Причина — необязательно">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
    </Dialog>
  );
}

function CompleteDialog({ item, onClose, onDone }: { item: ReceptionRequestItem; onClose: () => void; onDone: () => void }) {
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const payload: CompleteReceptionRequestInput = { version: item.version, resolution: resolution.trim() || undefined };
      await api.post(`/reception/requests/${item.id}/complete`, payload, { 'Idempotency-Key': idem.key() });
      idem.reset();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось завершить приём');
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Завершить «${item.title}»`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Назад
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy} loading={busy}>
            Завершить обсуждение
          </Button>
        </>
      }
    >
      <Field label="Результат обсуждения — необязательно">
        <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={3000} rows={3} />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
    </Dialog>
  );
}

// --- вкладка владельца: очередь ---

function QueueView() {
  const searchParams = useSearchParams();
  // «Стол руководителя» (ТЗ v1.0, 05.10.2026, раздел 9) — переход с главной
  // по конкретному обращению: ?focus=<id> подсвечивает и прокручивает к
  // нему, если оно всё ещё в доступной очереди; если уже нет — обычная
  // очередь + "Статус вопроса изменился" (ниже, после загрузки данных).
  const focusId = searchParams.get('focus');
  const [data, setData] = useState<ReceptionQueueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [expiredOnly, setExpiredOnly] = useState(false);
  const [rejecting, setRejecting] = useState<ReceptionRequestItem | null>(null);
  const [completing, setCompleting] = useState<ReceptionRequestItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const dialogOpen = Boolean(rejecting || completing);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    const params = new URLSearchParams({ limit: '50' });
    if (submittedSearch) params.set('search', submittedSearch);
    if (expiredOnly) params.set('expiredOnly', 'true');
    api
      .get<ReceptionQueueView>(`/reception/queue?${params.toString()}`)
      .then((r) => {
        if (requestId !== requestIdRef.current) return;
        setData(r);
        setError(null);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить очередь');
      });
  }, [submittedSearch, expiredOnly]);

  useEffect(load, [load]);
  useVisiblePolling(load, !dialogOpen);

  // focusMissing — производное значение (не отдельный useState + setState в
  // эффекте: React-антипаттерн, лишний рендер), скролл к карточке — настоящий
  // DOM-эффект, остаётся в useEffect.
  const focusMissing = Boolean(
    focusId && data && data.current?.id !== focusId && !data.items.some((i) => i.id === focusId),
  );

  useEffect(() => {
    if (!focusId || !data) return;
    if (data.current?.id === focusId || data.items.some((i) => i.id === focusId)) {
      document.getElementById(`reception-item-${focusId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focusId, data]);

  async function moveToEnd(item: ReceptionRequestItem) {
    setBusyId(item.id);
    try {
      await api.post(`/reception/requests/${item.id}/move-to-end`, { version: item.version }, { 'Idempotency-Key': crypto.randomUUID() });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось перенести обращение');
    } finally {
      setBusyId(null);
    }
  }

  async function call(item: ReceptionRequestItem) {
    setBusyId(item.id);
    try {
      await api.post(`/reception/requests/${item.id}/call`, { version: item.version }, { 'Idempotency-Key': crypto.randomUUID() });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось вызвать сотрудника');
    } finally {
      setBusyId(null);
    }
  }

  async function returnToQueue(item: ReceptionRequestItem) {
    setBusyId(item.id);
    try {
      await api.post(`/reception/requests/${item.id}/return-to-queue`, { version: item.version }, { 'Idempotency-Key': crypto.randomUUID() });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось вернуть в очередь');
    } finally {
      setBusyId(null);
    }
  }

  const hasCurrent = Boolean(data?.current);

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Приёмная</h1>
      <p className="ds-field-hint" style={{ marginBottom: 16 }}>
        Ожидают: {data?.totalWaiting ?? '—'}
      </p>

      {focusMissing && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="info">Статус вопроса изменился</Alert>
        </div>
      )}

      {data?.current && (
        <div id={`reception-item-${data.current.id}`}>
        <Card style={{ marginBottom: 16, borderLeft: `3px solid ${focusId === data.current.id ? 'var(--agent)' : 'var(--warn)'}` }}>
          <h2 style={{ marginBottom: 6 }}>Сейчас вызван</h2>
          <p>
            <strong>{data.current.author.fullName}</strong> — {data.current.title}
          </p>
          <p className="ds-field-hint">
            Вызван {formatDateTime(data.current.lastCalledAt)}
            {' · '}
            {data.current.notificationStatus === 'SENT' && 'уведомление доставлено'}
            {data.current.notificationStatus === 'PENDING' && 'уведомление отправляется…'}
            {data.current.notificationStatus === 'FAILED' && 'не удалось отправить уведомление'}
            {data.current.notificationStatus === 'SKIPPED' && 'уведомление не отправлено — сообщите сотруднику другим способом'}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button variant="primary" onClick={() => setCompleting(data.current)} disabled={busyId === data.current.id}>
              Завершить
            </Button>
            <Button variant="secondary" onClick={() => returnToQueue(data.current!)} disabled={busyId === data.current.id}>
              Вернуть в очередь
            </Button>
          </div>
        </Card>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedSearch(search.trim());
          }}
          style={{ display: 'flex', gap: 6 }}
        >
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по теме/сотруднику" style={{ minWidth: 220 }} />
          <Button type="submit" variant="secondary" size="sm">
            Искать
          </Button>
        </form>
        <Checkbox label="Только с истёкшим сроком" checked={expiredOnly} onChange={(e) => setExpiredOnly(e.target.checked)} />
        <IconButton icon={RefreshCw} label="Обновить" variant="outline" size="sm" onClick={load} style={{ marginLeft: 'auto' }} />
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <p className="ds-field-hint">Загрузка…</p>}
      {data && data.items.length === 0 && (
        <EmptyState title={submittedSearch || expiredOnly ? 'Ничего не найдено' : 'Ожидающих вопросов нет'}>
          {(submittedSearch || expiredOnly) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSearch('');
                setSubmittedSearch('');
                setExpiredOnly(false);
              }}
            >
              Сбросить фильтры
            </Button>
          )}
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <>
          <ul className="plain-list">
            {data.items.map((item) => (
              <li
                key={item.id}
                id={`reception-item-${item.id}`}
                className="plain-list-row"
                style={{ alignItems: 'flex-start', background: focusId === item.id ? 'var(--surface-2)' : undefined }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <strong>{item.author.fullName}</strong>
                    {item.author.status === 'INACTIVE' && <Badge>Сотрудник неактивен</Badge>}
                    <span>— {item.title}</span>
                    {isExpired(item.desiredBy) && <Badge tone="warn">Истёк срок</Badge>}
                  </div>
                  <p className="ds-field-hint" style={{ marginTop: 4 }}>
                    {REQUEST_TYPE_LABELS[item.requestType]}
                    {item.expectedMinutes && <> · ~{item.expectedMinutes} мин</>}
                    {' · подано '}
                    {formatDateTime(item.createdAt)}
                    {item.desiredBy && <> · нужен ответ до {formatDateTime(item.desiredBy)}</>}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
                  <Button variant="secondary" size="sm" onClick={() => moveToEnd(item)} disabled={busyId === item.id || hasCurrent}>
                    В конец
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => call(item)}
                    disabled={busyId === item.id || hasCurrent}
                    title={hasCurrent ? 'Сначала завершите текущий приём или верните вопрос в очередь' : undefined}
                  >
                    Вызвать
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setRejecting(item)} disabled={busyId === item.id}>
                    Отказать
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {data.totalCount > data.items.length && (
            <p className="ds-field-hint" style={{ marginTop: 8 }}>
              Показано {data.items.length} из {data.totalCount}.
            </p>
          )}
        </>
      )}

      {rejecting && (
        <RejectDialog
          item={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            setRejecting(null);
            load();
          }}
        />
      )}
      {completing && (
        <CompleteDialog
          item={completing}
          onClose={() => setCompleting(null)}
          onDone={() => {
            setCompleting(null);
            load();
          }}
        />
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
            { value: 'COMPLETED', label: 'Обсуждено' },
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
  const isOwner = user?.role === 'OWNER';
  const [tab, setTab] = useState<OwnerTab>('queue');

  if (!isOwner) {
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
            { value: 'queue', label: 'Очередь' },
            { value: 'history', label: 'История' },
            { value: 'mine', label: 'Мои обращения' },
          ]}
          value={tab}
          onChange={(v) => setTab(v as OwnerTab)}
        />
      </div>
      {tab === 'queue' && <QueueView />}
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

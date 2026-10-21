'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, FolderPlus, Play, RotateCcw, Square } from 'lucide-react';
import type {
  CreateMailActionPlanInput,
  MailActionGroupType,
  MailActionItem,
  MailActionItemStatus,
  MailActionPlan,
  MailActionPlanContext,
  MailActionPlanExecution,
  MailActionPlanItems,
  MailActionPlanStatus,
  MailActionType,
  MailFolder,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Field, Select, Textarea } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';

// Почтовый ИИ-агент v2.0 (ТЗ 05.10.2026) — вкладка «Разбор» на /mail:
// поручение → агент предлагает действия по уже синкнутым письмам → владелец
// согласует по группам (раздел 7 ТЗ: у каждой группы своя кнопка, корзина —
// отдельно) → исполнение в Mail.ru с журналом, остановкой и повтором.

const POLL_MS = 3_000;

const PLAN_STATUS: Record<MailActionPlanStatus, [BadgeTone, string]> = {
  ANALYZING: ['agent', 'Агент разбирает'],
  READY: ['info', 'Готов к согласованию'],
  EXECUTING: ['warn', 'Выполняется'],
  DONE: ['ok', 'Выполнен'],
  CANCELLED: ['neutral', 'Отменён'],
};

const ITEM_STATUS: Record<MailActionItemStatus, [BadgeTone, string]> = {
  DRAFT: ['draft', 'Черновик'],
  NEEDS_REVIEW: ['neutral', 'Ждёт согласия'],
  APPROVED: ['info', 'Согласовано'],
  QUEUED: ['info', 'В очереди'],
  RUNNING: ['warn', 'Выполняется'],
  SUCCEEDED: ['ok', 'Выполнено'],
  FAILED: ['danger', 'Ошибка'],
  UNKNOWN: ['warn', 'Результат неизвестен'],
  SKIPPED_CHANGED: ['neutral', 'Письмо изменилось'],
  BLOCKED_DEPENDENCY: ['neutral', 'Ждёт другой пункт'],
  CANCELLED: ['neutral', 'Остановлено'],
  COMPENSATED: ['neutral', 'Отменено'],
};

const ACTION_LABELS: Record<MailActionType, string> = {
  ARCHIVE: 'В архив',
  MOVE: 'Переместить',
  CREATE_FOLDER: 'Создать папку',
  SET_READ: 'Отметить прочитанным',
  SET_UNREAD: 'Отметить непрочитанным',
  FLAG: 'Поставить флажок',
  UNFLAG: 'Снять флажок',
  TRASH: 'В корзину',
  CREATE_TASK: 'Создать задачу',
  SAVE_ATTACHMENT: 'Сохранить вложение',
  DRAFT_REPLY: 'Черновик ответа',
  SEND_REPLY: 'Отправить ответ',
  FORWARD: 'Переслать',
  PROPOSE_MEETING: 'Предложить встречу',
  CREATE_EVENT: 'Создать событие',
  WATCH_REPLY: 'Следить за ответом',
  WATCH_COMMITMENT: 'Следить за обещанием',
  DRAFT_REMINDER: 'Черновик напоминания',
};

const GROUPS: { type: MailActionGroupType; title: string; approveLabel: string }[] = [
  { type: 'MAILBOX_ORDER', title: 'Порядок в почте', approveLabel: 'Навести порядок' },
  { type: 'WORK_OBJECTS', title: 'Рабочие объекты', approveLabel: 'Создать' },
  { type: 'EXTERNAL_SEND', title: 'Внешняя отправка', approveLabel: 'Отправить' },
  { type: 'TRASH', title: 'Корзина', approveLabel: 'Переместить в корзину' },
];

const ERROR_LABELS: Record<string, string> = {
  ARCHIVE_FOLDER_MISSING: 'В ящике нет папки «Архив» — выберите или создайте папку.',
  TRASH_FOLDER_MISSING: 'В ящике не найдена корзина.',
  MISSING_FOLDER_PATH: 'Не указана папка.',
  MISSING_FOLDER_NAME: 'Не указано имя папки.',
  LOCATOR_CHANGED: 'Письмо переместили или изменили после анализа.',
  NOT_IMPLEMENTED: 'Это действие агент пока не умеет выполнять.',
  EXECUTOR_ERROR: 'Mail.ru вернул ошибку.',
};

const EDITABLE: ReadonlySet<MailActionItemStatus> = new Set(['DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'FAILED', 'UNKNOWN', 'SKIPPED_CHANGED', 'BLOCKED_DEPENDENCY']);
const RETRIABLE: ReadonlySet<MailActionItemStatus> = new Set(['FAILED', 'UNKNOWN']);

const PERIODS = [
  { value: '7', label: 'За 7 дней' },
  { value: '30', label: 'За 30 дней' },
  { value: '90', label: 'За 90 дней' },
  { value: '', label: 'Вся почта' },
];

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function NewPlanForm({ onCreated }: { onCreated: (plan: MailActionPlan) => void }) {
  const [requestText, setRequestText] = useState('');
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: CreateMailActionPlanInput = { requestText: requestText.trim() };
      if (days) payload.since = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
      const plan = await api.post<MailActionPlan>('/mail/action-plans', payload, { 'Idempotency-Key': idem.key() });
      idem.reset();
      setRequestText('');
      onCreated(plan);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) idem.reset();
      setError(errorMessage(err, 'Не удалось отправить поручение'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
        <Field label="Поручение агенту">
          <Textarea
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Например: разложи рассылки в архив, важное отметь флажком"
            required
          />
        </Field>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Письма">
            <Select value={days} onChange={(e) => setDays(e.target.value)} options={PERIODS} />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !requestText.trim()} loading={busy}>
            Разобрать
          </Button>
        </div>
        <p className="ds-field-hint" style={{ margin: 0 }}>
          Агент только предлагает — в почте ничего не изменится, пока вы не согласуете.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
      </form>
    </Card>
  );
}

// Папка для ARCHIVE/MOVE — живой список папок ящика (GET /mail/folders ходит
// в Mail.ru, поэтому грузится только когда владелец решил поменять папку).
function FolderPicker({
  current,
  onPick,
  onCancel,
}: {
  current: string | null;
  onPick: (path: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [folders, setFolders] = useState<MailFolder[] | null>(null);
  const [value, setValue] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MailFolder[]>('/mail/folders')
      .then(setFolders)
      .catch((err) => setError(errorMessage(err, 'Не удалось получить папки ящика')));
  }, []);

  async function createFolder() {
    const name = window.prompt('Название новой папки');
    if (!name?.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const folder = await api.post<MailFolder>('/mail/folders', { name: name.trim() });
      setFolders((prev) => (prev && !prev.some((f) => f.path === folder.path) ? [...prev, folder] : prev));
      setValue(folder.path);
    } catch (err) {
      setError(errorMessage(err, 'Не удалось создать папку'));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await onPick(value);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
      {!folders && !error && <span className="ds-field-hint">Загрузка папок…</span>}
      {folders && (
        <Select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          options={[{ value: '', label: 'Выберите папку' }, ...folders.map((f) => ({ value: f.path, label: f.path }))]}
        />
      )}
      <Button type="button" size="sm" icon={FolderPlus} onClick={createFolder} disabled={busy || !folders}>
        Новая папка
      </Button>
      <Button type="button" size="sm" variant="primary" onClick={save} disabled={busy || !value}>
        Сохранить
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
        Отмена
      </Button>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

function ItemRow({
  item,
  message,
  onPatch,
}: {
  item: MailActionItem;
  message: MailActionPlanContext['messages'][string] | undefined;
  onPatch: (item: MailActionItem, body: { selected?: boolean; parameters?: Record<string, unknown> }) => Promise<void>;
}) {
  const [pickingFolder, setPickingFolder] = useState(false);
  const editable = EDITABLE.has(item.status);
  const [tone, label] = ITEM_STATUS[item.status];
  const folderPath = typeof item.parameters.folderPath === 'string' ? item.parameters.folderPath : null;
  const hasFolder = item.type === 'ARCHIVE' || item.type === 'MOVE';
  const errorCode = item.status === 'NEEDS_REVIEW' ? null : item.lastAttempt?.errorCode;

  return (
    <tr style={{ opacity: item.selected ? 1 : 0.55 }}>
      <td style={{ width: 1 }}>
        <input
          type="checkbox"
          checked={item.selected}
          disabled={!editable}
          onChange={(e) => onPatch(item, { selected: e.target.checked })}
          aria-label="Включить пункт"
        />
      </td>
      <td>
        <strong>{ACTION_LABELS[item.type]}</strong>
        {hasFolder && (
          <span className="ds-field-hint">
            {' → '}
            {folderPath ?? 'Архив'}
            {editable && !pickingFolder && (
              <button type="button" className="btn-link" onClick={() => setPickingFolder(true)} style={{ marginLeft: 6 }}>
                изменить
              </button>
            )}
          </span>
        )}
        <div>{message ? message.subject || '(без темы)' : 'Письмо не найдено в системе'}</div>
        {message && (
          <div className="ds-field-hint">
            {message.fromName?.trim() || message.fromAddress} · {formatDate(message.receivedAt)}
          </div>
        )}
        <div className="ds-field-hint">{item.reason}</div>
        {pickingFolder && (
          <FolderPicker
            current={folderPath}
            onCancel={() => setPickingFolder(false)}
            onPick={async (path) => {
              await onPatch(item, { parameters: { ...item.parameters, folderPath: path } });
              setPickingFolder(false);
            }}
          />
        )}
      </td>
      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
        <Badge tone={tone}>{label}</Badge>
        {errorCode && (
          <div className="ds-field-hint" style={{ whiteSpace: 'normal', maxWidth: 220, marginTop: 4 }}>
            {ERROR_LABELS[errorCode] ?? errorCode}
          </div>
        )}
      </td>
    </tr>
  );
}

function GroupCard({
  group,
  items,
  messages,
  conflictItemIds,
  planVersion,
  planId,
  onPatch,
  onChanged,
}: {
  group: (typeof GROUPS)[number];
  items: MailActionItem[];
  messages: MailActionPlanContext['messages'];
  conflictItemIds: ReadonlySet<string>;
  planVersion: number;
  planId: string;
  onPatch: (item: MailActionItem, body: { selected?: boolean; parameters?: Record<string, unknown> }) => Promise<void>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const ready = items.filter((i) => i.selected && i.status === 'NEEDS_REVIEW');
  const hasConflict = ready.some((i) => conflictItemIds.has(i.id));

  async function approve() {
    if (group.type === 'TRASH' && !window.confirm(`Переместить в корзину писем: ${ready.length}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(
        `/mail/action-plans/${planId}/approve`,
        { planVersion, groupType: group.type, itemIds: ready.map((i) => i.id) },
        { 'Idempotency-Key': idem.key() },
      );
      idem.reset();
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) idem.reset();
      setError(errorMessage(err, 'Не удалось согласовать'));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={group.title}
      style={{ marginBottom: 16 }}
      actions={
        ready.length > 0 && (
          <Button
            variant={group.type === 'TRASH' ? 'danger' : 'primary'}
            size="sm"
            icon={Play}
            onClick={approve}
            disabled={busy || hasConflict}
            loading={busy}
            title={hasConflict ? 'Сначала снимите один из конфликтующих пунктов' : undefined}
          >
            {group.approveLabel} · {ready.length}
          </Button>
        )
      }
    >
      {hasConflict && (
        <div style={{ marginBottom: 10 }}>
          <Alert tone="warn">Несколько пунктов противоречат друг другу для одного письма — оставьте один.</Alert>
        </div>
      )}
      {error && (
        <div style={{ marginBottom: 10 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <div className="ds-table-wrap">
        <table className="ds-table">
          <tbody>
            {items.map((item) => (
              <ItemRow key={item.id} item={item} message={messages[item.stableObjectIds[0]]} onPatch={onPatch} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ExecutionRow({
  execution,
  items,
  onChanged,
}: {
  execution: MailActionPlanExecution;
  items: MailActionItem[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const own = items.filter((i) => execution.itemIds.includes(i.id));
  const done = own.filter((i) => i.status === 'SUCCEEDED').length;
  const failed = own.filter((i) => RETRIABLE.has(i.status)).length;
  const active = execution.state === 'QUEUED' || execution.state === 'RUNNING';
  const group = GROUPS.find((g) => g.type === execution.groupType)?.title ?? execution.groupType;

  async function run(action: 'stop' | 'retry') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/mail/action-executions/${execution.id}/${action}`, undefined, { 'Idempotency-Key': idem.key() });
      idem.reset();
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) idem.reset();
      setError(errorMessage(err, 'Не удалось выполнить'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        {group}
        <div className="ds-field-hint">Согласовано {formatDate(execution.approvedAt)}</div>
        {error && <Alert tone="danger">{error}</Alert>}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {active ? (
          <Badge tone="warn">{execution.cancelRequestedAt ? 'Останавливается…' : 'Выполняется'}</Badge>
        ) : (
          <Badge tone={failed > 0 ? 'danger' : 'ok'}>
            {done} из {own.length} выполнено
          </Badge>
        )}
      </td>
      <td style={{ width: 1, whiteSpace: 'nowrap' }}>
        {active && !execution.cancelRequestedAt && (
          <Button size="sm" icon={Square} onClick={() => run('stop')} disabled={busy}>
            Остановить
          </Button>
        )}
        {!active && failed > 0 && (
          <Button size="sm" icon={RotateCcw} onClick={() => run('retry')} disabled={busy}>
            Повторить ошибки
          </Button>
        )}
      </td>
    </tr>
  );
}

function PlanView({ planId, onBack }: { planId: string; onBack: () => void }) {
  const [plan, setPlan] = useState<MailActionPlan | null>(null);
  const [data, setData] = useState<MailActionPlanItems | null>(null);
  const [context, setContext] = useState<MailActionPlanContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    Promise.all([
      api.get<MailActionPlan>(`/mail/action-plans/${planId}`),
      api.get<MailActionPlanItems>(`/mail/action-plans/${planId}/items`),
      api.get<MailActionPlanContext>(`/mail/action-plans/${planId}/context`),
    ])
      .then(([p, d, c]) => {
        if (requestId !== requestIdRef.current) return;
        setPlan(p);
        setData(d);
        setContext(c);
        setError(null);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(errorMessage(err, 'Не удалось загрузить план'));
      });
  }, [planId]);

  useEffect(load, [load]);

  const busy =
    plan?.status === 'ANALYZING' ||
    Boolean(context?.executions.some((e) => e.state === 'QUEUED' || e.state === 'RUNNING')) ||
    Boolean(data?.items.some((i) => i.status === 'QUEUED' || i.status === 'RUNNING'));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  async function patchItem(item: MailActionItem, body: { selected?: boolean; parameters?: Record<string, unknown> }) {
    setActionError(null);
    try {
      await api.patch(`/mail/action-plans/${planId}/items/${item.id}`, { version: item.version, ...body });
    } catch (err) {
      setActionError(errorMessage(err, 'Не удалось изменить пункт'));
    }
    load();
  }

  const conflictItemIds = new Set(data?.conflicts.flatMap((c) => c.itemLocalIds) ?? []);

  return (
    <>
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack} style={{ marginBottom: 12 }}>
        Все поручения
      </Button>
      {error && <Alert tone="danger">{error}</Alert>}
      {!plan && !error && <p className="ds-field-hint">Загрузка…</p>}
      {plan && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 600 }}>{plan.requestText}</div>
              <div className="ds-field-hint">{formatDate(plan.createdAt)}</div>
            </div>
            <Badge tone={PLAN_STATUS[plan.status][0]}>{PLAN_STATUS[plan.status][1]}</Badge>
          </div>
          {plan.coverage?.error && (
            <div style={{ marginTop: 10 }}>
              <Alert tone="danger">Агент не смог разобрать почту: {plan.coverage.error}</Alert>
            </div>
          )}
        </Card>
      )}
      {actionError && (
        <div style={{ marginBottom: 12 }}>
          <Alert tone="danger">{actionError}</Alert>
        </div>
      )}
      {plan?.status === 'ANALYZING' && <p className="ds-field-hint">Агент читает письма и готовит предложения…</p>}
      {plan && plan.status !== 'ANALYZING' && data && data.items.length === 0 && !plan.coverage?.error && (
        <EmptyState title="Предложений нет" description="Агент не нашёл писем, к которым подходит это поручение." />
      )}
      {plan && data && context &&
        GROUPS.map((group) => {
          const items = data.items.filter((i) => i.groupType === group.type);
          if (items.length === 0) return null;
          return (
            <GroupCard
              key={group.type}
              group={group}
              items={items}
              messages={context.messages}
              conflictItemIds={conflictItemIds}
              planVersion={plan.version}
              planId={plan.id}
              onPatch={patchItem}
              onChanged={load}
            />
          );
        })}
      {data && context && context.executions.length > 0 && (
        <Card title="Исполнение">
          <div className="ds-table-wrap">
            <table className="ds-table">
              <tbody>
                {context.executions.map((e) => (
                  <ExecutionRow key={e.id} execution={e} items={data.items} onChanged={load} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

export function MailAgentTab() {
  const [plans, setPlans] = useState<MailActionPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<MailActionPlan[]>('/mail/action-plans')
      .then((p) => {
        setPlans(p);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err, 'Не удалось загрузить поручения')));
  }, []);

  useEffect(load, [load]);

  if (openId) {
    return (
      <PlanView
        key={openId}
        planId={openId}
        onBack={() => {
          setOpenId(null);
          load();
        }}
      />
    );
  }

  return (
    <>
      <NewPlanForm onCreated={(plan) => setOpenId(plan.id)} />
      {error && <Alert tone="danger">{error}</Alert>}
      {!plans && !error && <p className="ds-field-hint">Загрузка…</p>}
      {plans && plans.length === 0 && (
        <EmptyState title="Поручений пока нет" description="Опишите, что сделать с почтой, — агент предложит действия на согласование." />
      )}
      {plans && plans.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>Поручение</th>
                <th>Статус</th>
                <th>Дата</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} onClick={() => setOpenId(p.id)} style={{ cursor: 'pointer' }}>
                  <td>{p.requestText}</td>
                  <td>
                    <Badge tone={PLAN_STATUS[p.status][0]}>{PLAN_STATUS[p.status][1]}</Badge>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDate(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, CalendarPlus, Play, RotateCcw, Search, Square } from 'lucide-react';
import type {
  AvailabilityResult,
  CalendarAction,
  CalendarActionStatus,
  CalendarActionType,
  CalendarPlan,
  CalendarPlanExecution,
  CalendarPlanStatus,
  CalendarPolicy,
  CreateCalendarPlanInput,
  FindAvailabilityInput,
  UpdateCalendarPolicyInput,
  WorkingHoursRule,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';

// Календарный агент (ТЗ календарного агента, 07.10.2026) — вкладки на
// /calendar: поиск свободного времени (FIND_SLOTS), рабочие часы
// (CalendarPolicy), планы на согласование (план → согласие → исполнение с
// журналом, остановкой и повтором). Встреча из найденного слота создаётся
// не напрямую, а планом — владелец видит и согласует, что именно агент сделает.

const POLL_MS = 3_000;

const PLAN_STATUS: Record<CalendarPlanStatus, [BadgeTone, string]> = {
  DRAFT: ['draft', 'Черновик'],
  NEEDS_APPROVAL: ['info', 'Ждёт согласия'],
  APPROVED: ['info', 'Согласован'],
  EXECUTING: ['warn', 'Выполняется'],
  SUCCEEDED: ['ok', 'Выполнен'],
  PARTIAL: ['warn', 'Выполнен частично'],
  FAILED: ['danger', 'Не выполнен'],
  CANCELLED: ['neutral', 'Отменён'],
  EXPIRED: ['neutral', 'Истёк'],
};

const ACTION_STATUS: Record<CalendarActionStatus, [BadgeTone, string]> = {
  PENDING: ['neutral', 'Ждёт'],
  RUNNING: ['warn', 'Выполняется'],
  SUCCEEDED: ['ok', 'Выполнено'],
  FAILED: ['danger', 'Ошибка'],
  UNKNOWN: ['warn', 'Результат неизвестен'],
  SKIPPED_CHANGED: ['neutral', 'Событие изменилось'],
  BLOCKED_DEPENDENCY: ['neutral', 'Ждёт другое действие'],
  CANCELLED: ['neutral', 'Остановлено'],
};

const ACTION_LABELS: Record<CalendarActionType, string> = {
  CREATE_EVENT: 'Создать встречу',
  UPDATE_EVENT: 'Изменить встречу',
  RESCHEDULE_EVENT: 'Перенести встречу',
  CANCEL_EVENT: 'Отменить встречу',
};

const ERROR_LABELS: Record<string, string> = {
  EVENT_NOT_FOUND: 'Встреча уже удалена.',
  EVENT_VERSION_CONFLICT: 'Встречу изменили после составления плана.',
  MISSING_TARGET_EVENT: 'Не указана встреча.',
  EVENTS_SERVICE_ERROR: 'Календарь вернул ошибку.',
  EXECUTOR_ERROR: 'Календарь вернул ошибку.',
  NOT_IMPLEMENTED: 'Это действие агент пока не умеет выполнять.',
};

const RETRIABLE: ReadonlySet<CalendarActionStatus> = new Set(['FAILED', 'UNKNOWN']);

// Пн..Вс в порядке недели, weekday как в Date.getDay() (0 — воскресенье).
const WEEKDAYS: { weekday: number; label: string }[] = [
  { weekday: 1, label: 'Пн' },
  { weekday: 2, label: 'Вт' },
  { weekday: 3, label: 'Ср' },
  { weekday: 4, label: 'Чт' },
  { weekday: 5, label: 'Пт' },
  { weekday: 6, label: 'Сб' },
  { weekday: 0, label: 'Вс' },
];

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function formatDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

function formatSlot(start: string, end: string): string {
  const s = new Date(start);
  const day = s.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
  const t = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${t(s)}–${t(new Date(end))}`;
}

function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// --- поиск свободного времени ---

function SlotPlanForm({ slot, onPlanned, onCancel }: { slot: { start: string; end: string }; onPlanned: (planId: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: CreateCalendarPlanInput = {
        requestText: `${title.trim()} — ${formatSlot(slot.start, slot.end)}`,
        actions: [
          {
            localId: 'create',
            type: 'CREATE_EVENT',
            parameters: { title: title.trim(), startAt: slot.start, endAt: slot.end, ...(location.trim() ? { location: location.trim() } : {}) },
          },
        ],
      };
      const plan = await api.post<CalendarPlan>('/calendar/plans', payload, { 'Idempotency-Key': idem.key() });
      idem.reset();
      onPlanned(plan.id);
    } catch (err) {
      setError(errorMessage(err, 'Не удалось составить план'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
      <Field label="Название">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
      </Field>
      <Field label="Место">
        <Input value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" size="sm" disabled={busy || !title.trim()} loading={busy}>
        Составить план
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
        Отмена
      </Button>
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  );
}

function AvailabilityPanel({ onPlanned }: { onPlanned: (planId: string) => void }) {
  const today = new Date();
  const [from, setFrom] = useState(toDateInput(today));
  const [to, setTo] = useState(toDateInput(new Date(today.getTime() + 7 * 86_400_000)));
  const [duration, setDuration] = useState<FindAvailabilityInput['durationMinutes']>(30);
  const [result, setResult] = useState<AvailabilityResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planningSlot, setPlanningSlot] = useState<string | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setPlanningSlot(null);
    try {
      const payload: FindAvailabilityInput = {
        from: new Date(`${from}T00:00`).toISOString(),
        to: new Date(`${to}T23:59`).toISOString(),
        durationMinutes: duration,
        maxResults: 5,
      };
      setResult(await api.post<AvailabilityResult>('/calendar/availability', payload));
    } catch (err) {
      setError(errorMessage(err, 'Не удалось найти время'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card style={{ marginBottom: 16 }}>
        <form onSubmit={search} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="С">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </Field>
          <Field label="По">
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
          </Field>
          <Field label="Длительность">
            <SegmentedControl
              options={[
                { value: '15', label: '15 мин' },
                { value: '30', label: '30 мин' },
                { value: '60', label: '1 час' },
              ]}
              value={String(duration)}
              onChange={(v) => setDuration(Number(v) as FindAvailabilityInput['durationMinutes'])}
            />
          </Field>
          <Button type="submit" variant="primary" icon={Search} disabled={busy} loading={busy}>
            Найти время
          </Button>
        </form>
        <p className="ds-field-hint" style={{ margin: '10px 0 0' }}>
          С учётом рабочих часов, буферов между встречами и занятости в Google Calendar.
        </p>
      </Card>
      {error && <Alert tone="danger">{error}</Alert>}
      {result?.status === 'UNKNOWN' && (
        <Alert tone="warn">Не удалось проверить занятость в Google Calendar — свободное время неизвестно. Проверьте подключение и повторите.</Alert>
      )}
      {result?.status === 'OK' && result.slots.length === 0 && (
        <EmptyState title="Свободного времени нет" description="Попробуйте расширить период или сократить длительность." />
      )}
      {result?.status === 'OK' && result.slots.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <tbody>
              {result.slots.map((slot) => (
                <tr key={slot.start}>
                  <td style={{ textTransform: 'capitalize' }}>
                    {formatSlot(slot.start, slot.end)}
                    {planningSlot === slot.start && <SlotPlanForm slot={slot} onPlanned={onPlanned} onCancel={() => setPlanningSlot(null)} />}
                  </td>
                  <td style={{ width: 1, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                    {planningSlot !== slot.start && (
                      <Button size="sm" icon={CalendarPlus} onClick={() => setPlanningSlot(slot.start)}>
                        Запланировать
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// --- рабочие часы ---

function PolicyPanel() {
  const [policy, setPolicy] = useState<CalendarPolicy | null>(null);
  const [hours, setHours] = useState<Record<number, { start: string; end: string } | null>>({});
  const [buffer, setBuffer] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((p: CalendarPolicy) => {
    setPolicy(p);
    const byDay: Record<number, { start: string; end: string } | null> = {};
    for (const { weekday } of WEEKDAYS) {
      const rule = p.workingHours.find((r) => r.weekday === weekday);
      byDay[weekday] = rule ? { start: minutesToTime(rule.startMinute), end: minutesToTime(rule.endMinute) } : null;
    }
    setHours(byDay);
    setBuffer(String(p.bufferMinutes));
    setNotice(String(p.minNoticeHours));
  }, []);

  useEffect(() => {
    api
      .get<CalendarPolicy>('/calendar/policy')
      .then(apply)
      .catch((err) => setError(errorMessage(err, 'Не удалось загрузить рабочие часы')));
  }, [apply]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!policy) return;
    const workingHours: WorkingHoursRule[] = [];
    for (const { weekday, label } of WEEKDAYS) {
      const h = hours[weekday];
      if (!h) continue;
      const startMinute = timeToMinutes(h.start);
      const endMinute = timeToMinutes(h.end);
      if (!(endMinute > startMinute)) {
        setError(`${label}: окончание должно быть позже начала`);
        return;
      }
      workingHours.push({ weekday, startMinute, endMinute });
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const payload: UpdateCalendarPolicyInput = {
        ...(policy.version !== null ? { version: policy.version } : {}),
        workingHours,
        bufferMinutes: Number(buffer),
        minNoticeHours: Number(notice),
      };
      apply(await api.patch<CalendarPolicy>('/calendar/policy', payload));
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, 'Не удалось сохранить'));
    } finally {
      setBusy(false);
    }
  }

  if (!policy) return error ? <Alert tone="danger">{error}</Alert> : <p className="ds-field-hint">Загрузка…</p>;

  return (
    <Card>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 520 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {WEEKDAYS.map(({ weekday, label }) => {
            const h = hours[weekday];
            return (
              <div key={weekday} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', width: 70 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(h)}
                    onChange={(e) => setHours((prev) => ({ ...prev, [weekday]: e.target.checked ? { start: '09:00', end: '18:00' } : null }))}
                  />
                  {label}
                </label>
                {h ? (
                  <>
                    <Input type="time" value={h.start} onChange={(e) => setHours((prev) => ({ ...prev, [weekday]: { ...h, start: e.target.value } }))} required />
                    <span>—</span>
                    <Input type="time" value={h.end} onChange={(e) => setHours((prev) => ({ ...prev, [weekday]: { ...h, end: e.target.value } }))} required />
                  </>
                ) : (
                  <span className="ds-field-hint">выходной</span>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="Буфер между встречами, мин">
            <Input type="number" min={0} value={buffer} onChange={(e) => setBuffer(e.target.value)} required />
          </Field>
          <Field label="Не раньше чем через, ч">
            <Input type="number" min={0} value={notice} onChange={(e) => setNotice(e.target.value)} required />
          </Field>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        {saved && <Alert tone="ok">Сохранено</Alert>}
        <div>
          <Button type="submit" variant="primary" disabled={busy} loading={busy}>
            Сохранить
          </Button>
        </div>
      </form>
    </Card>
  );
}

// --- планы агента ---

function ExecutionRow({ execution, actions, onChanged }: { execution: CalendarPlanExecution; actions: CalendarAction[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const own = actions.filter((a) => execution.actionIds.includes(a.id));
  const done = own.filter((a) => a.status === 'SUCCEEDED').length;
  const failed = own.filter((a) => RETRIABLE.has(a.status)).length;
  const active = execution.state === 'QUEUED' || execution.state === 'RUNNING';

  async function run(action: 'stop' | 'retry') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/calendar/action-executions/${execution.id}/${action}`, undefined, { 'Idempotency-Key': idem.key() });
      idem.reset();
      onChanged();
    } catch (err) {
      setError(errorMessage(err, 'Не удалось выполнить'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        Согласовано {formatDateTime(execution.approvedAt)}
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
  const [plan, setPlan] = useState<CalendarPlan | null>(null);
  const [actions, setActions] = useState<CalendarAction[] | null>(null);
  const [executions, setExecutions] = useState<CalendarPlanExecution[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const idem = useIdempotencyKey();
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    Promise.all([
      api.get<CalendarPlan>(`/calendar/plans/${planId}`),
      api.get<CalendarAction[]>(`/calendar/plans/${planId}/actions`),
      api.get<CalendarPlanExecution[]>(`/calendar/plans/${planId}/executions`),
    ])
      .then(([p, a, e]) => {
        if (requestId !== requestIdRef.current) return;
        setPlan(p);
        setActions(a);
        setExecutions(e);
        setError(null);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(errorMessage(err, 'Не удалось загрузить план'));
      });
  }, [planId]);

  useEffect(load, [load]);

  const busy = executions.some((e) => e.state === 'QUEUED' || e.state === 'RUNNING') || Boolean(actions?.some((a) => a.status === 'RUNNING'));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  const pending = actions?.filter((a) => a.status === 'PENDING' && !a.authorizationId) ?? [];

  async function approve() {
    if (!plan) return;
    setApproving(true);
    setApproveError(null);
    try {
      await api.post(`/calendar/plans/${plan.id}/approve`, { planVersion: plan.version, actionIds: pending.map((a) => a.id) }, { 'Idempotency-Key': idem.key() });
      idem.reset();
    } catch (err) {
      setApproveError(errorMessage(err, 'Не удалось согласовать'));
    } finally {
      setApproving(false);
      load();
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack} style={{ marginBottom: 12 }}>
        Все планы
      </Button>
      {error && <Alert tone="danger">{error}</Alert>}
      {!plan && !error && <p className="ds-field-hint">Загрузка…</p>}
      {plan && actions && (
        <Card
          style={{ marginBottom: 16 }}
          actions={
            plan.status === 'NEEDS_APPROVAL' &&
            pending.length > 0 && (
              <Button variant="primary" size="sm" icon={Play} onClick={approve} disabled={approving} loading={approving}>
                Согласовать и выполнить
              </Button>
            )
          }
        >
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>{plan.requestText}</div>
              <div className="ds-field-hint">{formatDateTime(plan.createdAt)}</div>
            </div>
            <Badge tone={PLAN_STATUS[plan.status][0]}>{PLAN_STATUS[plan.status][1]}</Badge>
          </div>
          {approveError && (
            <div style={{ marginBottom: 10 }}>
              <Alert tone="danger">{approveError}</Alert>
            </div>
          )}
          <div className="ds-table-wrap">
            <table className="ds-table">
              <tbody>
                {actions.map((a) => {
                  const errorCode = a.status === 'PENDING' ? null : a.lastAttempt?.errorCode;
                  return (
                    <tr key={a.id}>
                      <td>
                        <strong>{ACTION_LABELS[a.type]}</strong>
                        <div>{a.parameters.title ?? 'Встреча'}</div>
                        {a.parameters.startAt && a.parameters.endAt && (
                          <div className="ds-field-hint" style={{ textTransform: 'capitalize' }}>
                            {formatSlot(a.parameters.startAt, a.parameters.endAt)}
                            {a.parameters.location ? ` · ${a.parameters.location}` : ''}
                          </div>
                        )}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <Badge tone={ACTION_STATUS[a.status][0]}>{ACTION_STATUS[a.status][1]}</Badge>
                        {errorCode && (
                          <div className="ds-field-hint" style={{ whiteSpace: 'normal', maxWidth: 220, marginTop: 4 }}>
                            {ERROR_LABELS[errorCode] ?? errorCode}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {actions && executions.length > 0 && (
        <Card title="Исполнение">
          <div className="ds-table-wrap">
            <table className="ds-table">
              <tbody>
                {executions.map((e) => (
                  <ExecutionRow key={e.id} execution={e} actions={actions} onChanged={load} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function PlansPanel({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const [plans, setPlans] = useState<CalendarPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<CalendarPlan[]>('/calendar/plans')
      .then((p) => {
        setPlans(p);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err, 'Не удалось загрузить планы')));
  }, []);

  useEffect(load, [load]);

  if (openId) {
    return (
      <PlanView
        key={openId}
        planId={openId}
        onBack={() => {
          onOpen(null);
          load();
        }}
      />
    );
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!plans) return <p className="ds-field-hint">Загрузка…</p>;
  if (plans.length === 0) {
    return <EmptyState title="Планов пока нет" description="Найдите свободное время и запланируйте встречу — план появится здесь на согласование." />;
  }

  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
        <thead>
          <tr>
            <th>План</th>
            <th>Статус</th>
            <th>Дата</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.id} onClick={() => onOpen(p.id)} style={{ cursor: 'pointer' }}>
              <td>{p.requestText}</td>
              <td>
                <Badge tone={PLAN_STATUS[p.status][0]}>{PLAN_STATUS[p.status][1]}</Badge>
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type CalendarAgentTab = 'availability' | 'plans' | 'policy';

export function CalendarAgent({ tab, onTabChange }: { tab: CalendarAgentTab; onTabChange: (tab: CalendarAgentTab) => void }) {
  const [openPlanId, setOpenPlanId] = useState<string | null>(null);

  if (tab === 'availability') {
    return (
      <AvailabilityPanel
        onPlanned={(planId) => {
          setOpenPlanId(planId);
          onTabChange('plans');
        }}
      />
    );
  }
  if (tab === 'plans') return <PlansPanel openId={openPlanId} onOpen={setOpenPlanId} />;
  return <PolicyPanel />;
}

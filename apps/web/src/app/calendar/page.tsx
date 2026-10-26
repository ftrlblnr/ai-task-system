'use client';

import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { ExternalLink, Link2, Link2Off, Plus, RefreshCw, Settings, Trash2 } from 'lucide-react';
import type {
  CalendarEvent,
  CreateEventInput,
  EmployeeSummary,
  GoogleCalendarStatus,
  SetGoogleOAuthConfigInput,
} from '@ai-task-system/shared-types';
import { MANAGER_ROLES } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { DataOwnerScope, useActingAsLeader } from '@/components/data-owner-scope';
import { Avatar } from '@/components/avatar';
import { PageHeader } from '@/components/ui/card';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Textarea, Select } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { ConnectionBar, PageTabs, cx, type PageTab } from '@/components/ui';
import { CalendarAgent, type CalendarAgentTab } from '@/components/calendar-agent';
import { useAgentContext } from '@/components/agent-panel/agent-context';

function GoogleConnectionCard() {
  const params = useSearchParams();
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const actingAsLeader = useActingAsLeader();

  function load() {
    api
      .get<GoogleCalendarStatus>('/calendar/google/status')
      .then(setStatus)
      .catch(() => setError('Не удалось проверить статус подключения'));
  }

  useEffect(load, []);

  async function saveOAuthConfig(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload: SetGoogleOAuthConfigInput = { clientId, clientSecret };
      await api.post('/calendar/google/oauth-config', payload);
      setClientSecret('');
      // status.configured станет true — компонент сам переключится на
      // обычную кнопку «Подключить», это и есть подтверждение сохранения.
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить OAuth-клиент');
    } finally {
      setBusy(false);
    }
  }

  const justConnected = params.get('connected');

  async function connect() {
    setBusy(true);
    try {
      const { url } = await api.get<{ url: string }>('/calendar/google/connect');
      window.location.href = url;
    } catch {
      setError('Не удалось начать подключение Google Calendar');
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.delete('/calendar/google/disconnect');
      load();
    } catch {
      setError('Не удалось отключить Google Calendar');
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    try {
      await api.post('/calendar/google/sync');
    } catch {
      setError('Синхронизация не удалась');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  // Подключение Google — личное действие руководителя (вход в её аккаунт),
  // администратору в её режиме — только статус и синхронизация.
  if (actingAsLeader && !status.connected) {
    return <ConnectionBar on={false} title="Google Calendar руководителя не подключён" meta="Подключить его может только она сама" />;
  }

  // configured=false — на сервере нет GOOGLE_CLIENT_ID/SECRET (см. комментарий
  // в CalendarController.status): кнопка «Подключить» в этом состоянии всегда
  // упадёт с невнятной ошибкой, поэтому вместо неё — инструкция по настройке
  // OAuth-клиента в Google Cloud Console, которую больше никто, кроме
  // владельца проекта, выполнить не может. Инструкция — по кнопке «Настроить».
  if (!status.configured) {
    const redirectUri = `${process.env.NEXT_PUBLIC_API_URL}/calendar/google/callback`;
    return (
      <ConnectionBar
        on={false}
        title="Google Calendar не настроен"
        meta="Нужен OAuth-клиент в Google Cloud Console — один раз"
        actions={
          !setupOpen && (
            <Button variant="secondary" size="sm" icon={Settings} onClick={() => setSetupOpen(true)}>
              Настроить
            </Button>
          )
        }
      >
        {setupOpen && (
          <div className="conn-bar-setup">
            <ol className="setup-steps">
              <li>
                Открыть{' '}
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
                  Google Cloud Console <ExternalLink size={12} strokeWidth={1.75} />
                </a>{' '}
                — создать проект (или выбрать существующий).
              </li>
              <li>
                <strong>APIs &amp; Services → OAuth consent screen</strong> — тип <strong>External</strong>; если
                приложение не проходит верификацию Google, добавить свой email в <strong>Test users</strong>.
              </li>
              <li>
                <strong>APIs &amp; Services → Library</strong> — найти <strong>Google Calendar API</strong> и включить.
              </li>
              <li>
                <strong>APIs &amp; Services → Credentials → Create Credentials → OAuth client ID</strong>, тип{' '}
                <strong>Web application</strong>.
              </li>
              <li>
                В <strong>Authorized redirect URIs</strong> добавить ровно это значение: <code className="mono chip">{redirectUri}</code>
              </li>
              <li>Скопировать <strong>Client ID</strong> и <strong>Client Secret</strong> и вставить их в форму ниже.</li>
            </ol>

            <form onSubmit={saveOAuthConfig}>
              <Field label="Client ID">
                <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={status.clientId ?? '...apps.googleusercontent.com'} required />
              </Field>
              <Field label="Client Secret">
                <Input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={status.clientId ? 'уже сохранён — введите заново, чтобы заменить' : 'GOCSPX-...'}
                  required
                />
              </Field>
              {status.clientId && (
                <p className="panel-hint">
                  Сейчас сохранён Client ID <code className="mono">{status.clientId}</code>. Заполните оба поля, чтобы заменить.
                </p>
              )}
              {error && <Alert tone="danger">{error}</Alert>}
              <div className="panel-actions">
                <Button type="submit" variant="primary" disabled={busy} loading={busy}>
                  Сохранить
                </Button>
                <Button type="button" variant="secondary" onClick={() => setSetupOpen(false)} disabled={busy}>
                  Отмена
                </Button>
              </div>
            </form>
          </div>
        )}
      </ConnectionBar>
    );
  }

  return (
    <ConnectionBar
      on={status.connected}
      title={
        status.connected ? (
          <>
            Синхронизировано с <strong>{status.googleAccountEmail}</strong>
          </>
        ) : (
          'Google Calendar не подключён'
        )
      }
      meta={
        status.connected
          ? status.lastSyncAt
            ? `Обновлено ${new Date(status.lastSyncAt).toLocaleString('ru-RU')}`
            : 'Ещё не синхронизировано'
          : 'События хранятся только внутри системы'
      }
      actions={
        status.connected ? (
          <>
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={syncNow} disabled={busy}>
              Синхронизировать
            </Button>
            {!actingAsLeader && (
              <Button variant="secondary" size="sm" icon={Link2Off} onClick={disconnect} disabled={busy}>
                Отключить
              </Button>
            )}
          </>
        ) : (
          <Button variant="secondary" size="sm" icon={Link2} onClick={connect} disabled={busy}>
            Подключить
          </Button>
        )
      }
    >
      {justConnected === '1' && <Alert tone="ok">Google Calendar подключён.</Alert>}
      {justConnected === '0' && <Alert tone="danger">Подключение не удалось — попробуйте ещё раз.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
    </ConnectionBar>
  );
}

// Раздел 18.2 ТЗ календарного агента — POST /events требует Idempotency-Key
// (тот же приём, что reception/page.tsx): ключ сгенерирован один раз на
// попытку создания и переиспользуется при повторе ТОГО ЖЕ действия,
// сбрасывается на новый только после успеха.
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

function NewEventForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idem = useIdempotencyKey();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload: CreateEventInput = {
        title,
        location: location || undefined,
        description: description || undefined,
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
      };
      await api.post('/events', payload, { 'Idempotency-Key': idem.key() });
      idem.reset();
      setTitle('');
      setLocation('');
      setDescription('');
      setStart('');
      setEnd('');
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) idem.reset();
      setError(err instanceof ApiError ? err.message : 'Не удалось создать событие');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="ds-card form-panel">
      <h2>Новое событие</h2>
      <Field label="Название">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <Field label="Начало">
        <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
      </Field>
      <Field label="Окончание">
        <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
      </Field>
      <Field label="Место">
        <Input value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
      <Field label="Описание">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="panel-actions">
        <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
          Создать событие
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

function EventsAgenda() {
  // «Стол руководителя» (ТЗ v1.0, 05.10.2026, раздел 10) — переход с
  // главной по конкретной встрече: ?event=<id> прокручивает к ней; если
  // событие удалено/недоступно — обычный календарь без ошибки (раздел 10 ТЗ:
  // "стандартное сообщение и доступный календарь").
  const searchParams = useSearchParams();
  const focusEventId = searchParams.get('event');
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [addParticipantSel, setAddParticipantSel] = useState<Record<string, string>>({});

  function load() {
    api
      .get<CalendarEvent[]>('/events')
      .then(setEvents)
      .catch(() => setError('Не удалось загрузить события'));
  }

  useEffect(load, []);
  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => {});
  }, []);

  // «Стол руководителя» (ТЗ v1.0, 05.10.2026) — ?event= из перехода с
  // дашборда. eventMissing — производное значение (не отдельный useState +
  // setState в эффекте: React-антипаттерн, лишний рендер), скролл к карточке
  // — настоящий DOM-эффект, остаётся в useEffect.
  const eventMissing = Boolean(focusEventId && events && !events.some((e) => e.id === focusEventId));
  const focusedEvent = focusEventId ? events?.find((e) => e.id === focusEventId) : undefined;
  useAgentContext(focusedEvent ? { kind: 'event', id: focusedEvent.id, label: focusedEvent.title } : null);

  useEffect(() => {
    if (!focusEventId || !events) return;
    if (events.some((e) => e.id === focusEventId)) {
      document.getElementById(`calendar-event-${focusEventId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focusEventId, events]);

  async function remove(id: string) {
    try {
      await api.delete(`/events/${id}`);
      load();
    } catch {
      setError('Не удалось удалить событие');
    }
  }

  // Участники встречи (владелец 09.09.2026) — тот же паттерн, что
  // наблюдатели задач на tasks/[id]/page.tsx.
  async function addParticipant(eventId: string) {
    const employeeId = addParticipantSel[eventId];
    if (!employeeId) return;
    try {
      await api.post(`/events/${eventId}/participants`, { employeeId });
      setAddParticipantSel((prev) => ({ ...prev, [eventId]: '' }));
      load();
    } catch {
      setError('Не удалось добавить участника');
    }
  }

  async function removeParticipant(eventId: string, employeeId: string) {
    try {
      await api.delete(`/events/${eventId}/participants/${employeeId}`);
      load();
    } catch {
      setError('Не удалось убрать участника');
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!events) return <p className="ds-field-hint">Загрузка…</p>;

  if (events.length === 0) {
    return (
      <EmptyState title="Событий пока нет" description="Создайте первое событие или подключите Google Calendar, чтобы подтянуть существующие." />
    );
  }

  const byDay = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = new Date(ev.startAt).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
    byDay.set(key, [...(byDay.get(key) ?? []), ev]);
  }

  return (
    <div className="page-stack">
      {eventMissing && <Alert tone="info">Это событие больше недоступно</Alert>}
      <div>
        {[...byDay.entries()].map(([day, dayEvents]) => (
          <section key={day} className="cal-day">
            <h3 className="section-kicker">{day}</h3>
            <div className="ds-table-wrap">
              <table className="ds-table">
                <tbody>
                  {dayEvents.map((ev) => (
                    <tr key={ev.id} id={`calendar-event-${ev.id}`} className={cx('cal-event', focusEventId === ev.id && 'is-focused')}>
                      <td className="cal-event-time">
                        {ev.allDay
                          ? 'Весь день'
                          : `${new Date(ev.startAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}–${new Date(ev.endAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
                      </td>
                      <td>
                        <strong>{ev.title}</strong>
                        {ev.location && <span className="cal-event-place">{ev.location}</span>}
                        <div className="watchers-row">
                          {ev.participants.length > 0 && (
                            <div className="watchers-avatars">
                              {ev.participants.map((p) => (
                                <span key={p.id} className="watcher-chip" title={p.fullName}>
                                  <Avatar id={p.id} name={p.fullName} size={18} />
                                  <button
                                    type="button"
                                    className="watcher-remove"
                                    onClick={() => removeParticipant(ev.id, p.id)}
                                    aria-label={`Убрать ${p.fullName} из участников`}
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                          {employees.filter((e) => !ev.participants.some((p) => p.id === e.id)).length > 0 && (
                            <div className="watcher-add-form">
                              <Select
                                value={addParticipantSel[ev.id] ?? ''}
                                onChange={(e) => setAddParticipantSel((prev) => ({ ...prev, [ev.id]: e.target.value }))}
                                options={[
                                  { value: '', label: '+ Участник…' },
                                  ...employees.filter((e) => !ev.participants.some((p) => p.id === e.id)).map((e) => ({ value: e.id, label: e.fullName })),
                                ]}
                              />
                              <Button type="button" variant="secondary" size="sm" disabled={!addParticipantSel[ev.id]} onClick={() => addParticipant(ev.id)}>
                                Добавить
                              </Button>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="cal-event-tags">
                        {ev.status === 'DRAFT' && <Badge>Черновик</Badge>}
                        {ev.googleEventId && <Badge>Google</Badge>}
                      </td>
                      <td className="cal-event-actions">
                        <IconButton icon={Trash2} label="Удалить" variant="outline" size="sm" onClick={() => remove(ev.id)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

type CalendarTab = 'events' | CalendarAgentTab;

const CALENDAR_TABS: PageTab<CalendarTab>[] = [
  { value: 'events', label: 'События' },
  { value: 'availability', label: 'Свободное время' },
  { value: 'plans', label: 'Планы агента' },
  { value: 'policy', label: 'Рабочие часы' },
];

function CalendarBody() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<CalendarTab>('events');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Календарь"
        actions={
          !(tab === 'events' && creating) && (
            <Button
              variant="primary"
              icon={Plus}
              onClick={() => {
                setTab('events');
                setCreating(true);
              }}
            >
              Новое событие
            </Button>
          )
        }
      />
      <GoogleConnectionCard />
      <PageTabs tabs={CALENDAR_TABS} value={tab} onChange={setTab} label="Разделы календаря" />
      {tab === 'events' ? (
        <div className="page-stack">
          {creating && (
            <NewEventForm
              onClose={() => setCreating(false)}
              onCreated={() => {
                setCreating(false);
                setRefreshKey((k) => k + 1);
              }}
            />
          )}
          <EventsAgenda key={refreshKey} />
        </div>
      ) : (
        <CalendarAgent tab={tab} onTabChange={setTab} />
      )}
    </>
  );
}

export default function CalendarPage() {
  return (
    <Protected requireRole={MANAGER_ROLES}>
      <Suspense fallback={<p className="ds-field-hint">Загрузка…</p>}>
        <DataOwnerScope>
          <CalendarBody />
        </DataOwnerScope>
      </Suspense>
    </Protected>
  );
}

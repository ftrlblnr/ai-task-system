'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { CalendarDays, ExternalLink, Link2, Link2Off, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type {
  CalendarEvent,
  CreateEventInput,
  EmployeeSummary,
  GoogleCalendarStatus,
  SetGoogleOAuthConfigInput,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Avatar } from '@/components/avatar';
import { Card, PageHeader } from '@/components/ui/card';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Textarea, Select } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';

function GoogleConnectionCard() {
  const params = useSearchParams();
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

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

  // configured=false — на сервере нет GOOGLE_CLIENT_ID/SECRET (см. комментарий
  // в CalendarController.status): кнопка «Подключить» в этом состоянии всегда
  // упадёт с невнятной ошибкой, поэтому вместо неё — инструкция по настройке
  // OAuth-клиента в Google Cloud Console, которую больше никто, кроме
  // владельца проекта, выполнить не может.
  if (!status.configured) {
    const redirectUri = `${process.env.NEXT_PUBLIC_API_URL}/calendar/google/callback`;
    return (
      <Card style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 8 }}>Google Calendar не настроен</h2>
        <p className="ds-field-hint" style={{ marginBottom: 14 }}>
          Чтобы подключить синхронизацию, нужен OAuth-клиент в Google Cloud Console — разово, один раз:
        </p>
        <ol className="setup-steps">
          <li>
            Открыть{' '}
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
              Google Cloud Console <ExternalLink size={12} strokeWidth={1.75} style={{ verticalAlign: -1 }} />
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
            В <strong>Authorized redirect URIs</strong> добавить ровно это значение:
            <br />
            <code className="mono chip" style={{ display: 'inline-block', marginTop: 4, wordBreak: 'break-all' }}>
              {redirectUri}
            </code>
          </li>
          <li>Скопировать <strong>Client ID</strong> и <strong>Client Secret</strong> и вставить их в форму ниже.</li>
        </ol>

        <form onSubmit={saveOAuthConfig} style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--line)', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
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
            <p className="ds-field-hint">
              Сейчас сохранён Client ID <code className="mono">{status.clientId}</code>. Заполните оба поля, чтобы заменить.
            </p>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" variant="primary" disabled={busy} loading={busy}>
            Сохранить
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card style={{ marginBottom: 20 }}>
      {justConnected === '1' && (
        <p className="ds-field-hint" style={{ color: 'var(--ok)', marginBottom: 10 }}>
          Google Calendar подключён.
        </p>
      )}
      {justConnected === '0' && (
        <div style={{ marginBottom: 10 }}>
          <Alert tone="danger">Подключение не удалось — попробуйте ещё раз.</Alert>
        </div>
      )}

      {status.connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link2 size={16} strokeWidth={1.75} style={{ color: 'var(--ok)' }} />
          <span>
            Синхронизировано с <strong>{status.googleAccountEmail}</strong>
          </span>
          <Badge>{status.lastSyncAt ? `Обновлено: ${new Date(status.lastSyncAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'}</Badge>
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={syncNow} disabled={busy}>
            Синхронизировать
          </Button>
          <Button variant="secondary" size="sm" icon={Link2Off} onClick={disconnect} disabled={busy}>
            Отключить
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="ds-field-hint">Google Calendar не подключён — события хранятся только внутри системы.</span>
          <Button variant="secondary" size="sm" icon={Link2} onClick={connect} disabled={busy}>
            Подключить Google Calendar
          </Button>
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8 }}>
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

function NewEventForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      await api.post('/events', payload);
      setTitle('');
      setLocation('');
      setDescription('');
      setStart('');
      setEnd('');
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать событие');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button variant="primary" icon={Plus} onClick={() => setOpen(true)} style={{ marginBottom: 20 }}>
        Новое событие
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="ds-card" style={{ marginBottom: 20, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
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
      <div style={{ display: 'flex', gap: 10 }}>
        <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
          Создать событие
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

function EventsAgenda() {
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
    <div>
      {[...byDay.entries()].map(([day, dayEvents]) => (
        <div key={day} style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: '0.85rem', color: 'var(--ink-3)', textTransform: 'capitalize', marginBottom: 8 }}>{day}</h3>
          <div className="ds-table-wrap">
            <table className="ds-table">
              <tbody>
                {dayEvents.map((ev) => (
                  <tr key={ev.id}>
                    <td style={{ whiteSpace: 'nowrap', width: 120 }}>
                      {ev.allDay
                        ? 'Весь день'
                        : `${new Date(ev.startAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}–${new Date(ev.endAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`}
                    </td>
                    <td>
                      <strong>{ev.title}</strong>
                      {ev.location && <span className="ds-field-hint" style={{ marginLeft: 8 }}>{ev.location}</span>}
                      <div className="watchers-row" style={{ marginTop: 6 }}>
                        {ev.participants.length > 0 && (
                          <div className="watchers-avatars">
                            {ev.participants.map((p) => (
                              <span key={p.id} className="watcher-chip" title={p.fullName}>
                                <Avatar name={p.fullName} size={18} />
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
                          <div className="watcher-add-form" style={{ display: 'flex', gap: 6 }}>
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
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {ev.status === 'DRAFT' && <Badge>Черновик</Badge>}
                      {ev.googleEventId && <Badge>Google</Badge>}
                    </td>
                    <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                      <IconButton icon={Trash2} label="Удалить" variant="outline" size="sm" onClick={() => remove(ev.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function CalendarBody() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <GoogleConnectionCard />
      <NewEventForm onCreated={() => setRefreshKey((k) => k + 1)} />
      <EventsAgenda key={refreshKey} />
    </>
  );
}

export default function CalendarPage() {
  return (
    <Protected requireRole="OWNER">
      <PageHeader
        title={
          <>
            <CalendarDays size={22} strokeWidth={1.75} style={{ verticalAlign: -3, marginRight: 8 }} />
            Календарь
          </>
        }
        description="Личный календарь руководителя, двусторонне синхронизированный с Google Calendar (раздел 14.2 ТЗ / Адъютант). Единственный писатель с обеих сторон — руководитель."
      />
      <Suspense fallback={<p className="ds-field-hint">Загрузка…</p>}>
        <CalendarBody />
      </Suspense>
    </Protected>
  );
}

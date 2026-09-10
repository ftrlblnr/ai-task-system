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
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 8 }}>Google Calendar не настроен</h2>
        <p className="hint" style={{ marginBottom: 14 }}>
          Чтобы подключить синхронизацию, нужен OAuth-клиент в Google Cloud Console — разово, один раз:
        </p>
        <ol className="setup-steps">
          <li>
            Открыть{' '}
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">
              Google Cloud Console <ExternalLink size={12} strokeWidth={2} style={{ verticalAlign: -1 }} />
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

        <form onSubmit={saveOAuthConfig} className="form-card" style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
          <label>
            Client ID
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={status.clientId ?? '...apps.googleusercontent.com'}
              required
            />
          </label>
          <label>
            Client Secret
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={status.clientId ? 'уже сохранён — введите заново, чтобы заменить' : 'GOCSPX-...'}
              required
            />
          </label>
          {status.clientId && (
            <p className="hint">
              Сейчас сохранён Client ID <code className="mono">{status.clientId}</code>. Заполните оба поля, чтобы заменить.
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      {justConnected === '1' && <p className="hint" style={{ color: 'var(--ok)', marginBottom: 10 }}>Google Calendar подключён.</p>}
      {justConnected === '0' && <p className="error" style={{ marginBottom: 10 }}>Подключение не удалось — попробуйте ещё раз.</p>}

      {status.connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link2 size={16} strokeWidth={2} style={{ color: 'var(--ok)' }} />
          <span>
            Синхронизировано с <strong>{status.googleAccountEmail}</strong>
          </span>
          <span className="badge badge-muted">
            {status.lastSyncAt ? `Обновлено: ${new Date(status.lastSyncAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'}
          </span>
          <button className="btn-secondary btn-small" onClick={syncNow} disabled={busy}>
            <RefreshCw size={14} strokeWidth={2} />
            Синхронизировать
          </button>
          <button className="btn-secondary btn-small" onClick={disconnect} disabled={busy}>
            <Link2Off size={14} strokeWidth={2} />
            Отключить
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="hint">Google Calendar не подключён — события хранятся только внутри системы.</span>
          <button className="btn-secondary btn-small" onClick={connect} disabled={busy}>
            <Link2 size={14} strokeWidth={2} />
            Подключить Google Calendar
          </button>
        </div>
      )}
      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}
    </div>
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
      <button className="btn" onClick={() => setOpen(true)} style={{ marginBottom: 20 }}>
        <Plus size={16} strokeWidth={2.5} />
        Новое событие
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card form-card" style={{ marginBottom: 20 }}>
      <label>
        Название
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Начало
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
      </label>
      <label>
        Окончание
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
      </label>
      <label>
        Место
        <input value={location} onChange={(e) => setLocation(e.target.value)} />
      </label>
      <label>
        Описание
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </label>
      {error && <p className="error">{error}</p>}
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Создаём…' : 'Создать событие'}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
          Отмена
        </button>
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

  if (error) return <p className="error">{error}</p>;
  if (!events) return <p className="hint">Загрузка…</p>;

  if (events.length === 0) {
    return (
      <div className="empty-state">
        <strong>Событий пока нет</strong>
        <p className="hint">Создайте первое событие или подключите Google Calendar, чтобы подтянуть существующие.</p>
      </div>
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
          <h3 style={{ fontSize: '0.85rem', color: 'var(--ink-soft)', textTransform: 'capitalize', marginBottom: 8 }}>{day}</h3>
          <div className="table-wrap">
            <table className="table">
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
                      {ev.location && <span className="hint" style={{ marginLeft: 8 }}>{ev.location}</span>}
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
                          <div className="watcher-add-form">
                            <select
                              value={addParticipantSel[ev.id] ?? ''}
                              onChange={(e) => setAddParticipantSel((prev) => ({ ...prev, [ev.id]: e.target.value }))}
                            >
                              <option value="">+ Участник…</option>
                              {employees
                                .filter((e) => !ev.participants.some((p) => p.id === e.id))
                                .map((e) => (
                                  <option key={e.id} value={e.id}>
                                    {e.fullName}
                                  </option>
                                ))}
                            </select>
                            <button
                              type="button"
                              className="btn-secondary btn-small"
                              disabled={!addParticipantSel[ev.id]}
                              onClick={() => addParticipant(ev.id)}
                            >
                              Добавить
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {ev.status === 'DRAFT' && <span className="badge badge-muted">Черновик</span>}
                      {ev.googleEventId && <span className="badge">Google</span>}
                    </td>
                    <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                      <button className="btn-secondary btn-small" onClick={() => remove(ev.id)} aria-label="Удалить">
                        <Trash2 size={13} strokeWidth={2} />
                      </button>
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
      <div className="page-header">
        <h1>
          <CalendarDays size={22} strokeWidth={2.2} style={{ verticalAlign: -3, marginRight: 8 }} />
          Календарь
        </h1>
      </div>
      <p className="page-subtitle">
        Личный календарь руководителя, двусторонне синхронизированный с Google Calendar (раздел 14.2
        ТЗ / Адъютант). Единственный писатель с обеих сторон — руководитель.
      </p>
      <Suspense fallback={<p className="hint">Загрузка…</p>}>
        <CalendarBody />
      </Suspense>
    </Protected>
  );
}

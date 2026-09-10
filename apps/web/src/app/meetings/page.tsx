'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ExternalLink, Link2, Link2Off, Plus, RefreshCw } from 'lucide-react';
import type { MeetingSummary, PlaudStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';

// У Plaud нет self-service регистрации OAuth-приложения, и браузерный
// OAuth-редирект через наш домен Plaud отклоняет на шаге подтверждения
// (владелец 09.09.2026 воспроизвёл 400 эмпирически — см. комментарий в
// apps/api/src/plaud/plaud-oauth.service.ts). Поэтому вместо кнопки
// «Подключить» с редиректом — инструкция получить refresh_token локально
// через официальный CLI и вставить его сюда один раз.
function PlaudConnectionCard() {
  const [status, setStatus] = useState<PlaudStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState('');

  function load() {
    api
      .get<PlaudStatus>('/plaud/status')
      .then(setStatus)
      .catch(() => setError('Не удалось проверить статус подключения Plaud'));
  }

  useEffect(load, []);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/plaud/connect-token', { refreshToken });
      setRefreshToken('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключить Plaud — проверьте токен');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.delete('/plaud/disconnect');
      load();
    } catch {
      setError('Не удалось отключить Plaud');
    } finally {
      setBusy(false);
    }
  }

  async function syncNow(onDone: () => void) {
    setBusy(true);
    try {
      await api.post('/plaud/sync');
      onDone();
      load();
    } catch {
      setError('Синхронизация не удалась');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      {status.connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link2 size={16} strokeWidth={2} style={{ color: 'var(--ok)' }} />
          <span>Plaud подключён — записи импортируются автоматически.</span>
          <span className="badge badge-muted">
            {status.lastSyncAt ? `Обновлено: ${new Date(status.lastSyncAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'}
          </span>
          <button className="btn-secondary btn-small" onClick={() => syncNow(() => window.location.reload())} disabled={busy}>
            <RefreshCw size={14} strokeWidth={2} />
            Синхронизировать
          </button>
          <button className="btn-secondary btn-small" onClick={disconnect} disabled={busy}>
            <Link2Off size={14} strokeWidth={2} />
            Отключить
          </button>
          {error && <p className="error" style={{ width: '100%', marginTop: 4 }}>{error}</p>}
        </div>
      ) : (
        <>
          <h2 style={{ marginBottom: 8 }}>Plaud не подключён</h2>
          <p className="hint" style={{ marginBottom: 14 }}>
            У Plaud нет кнопки «Подключить» через браузер для этого сценария — нужно один раз получить
            токен на своём компьютере:
          </p>
          <ol className="setup-steps">
            <li>
              Установить Node.js, если ещё не установлен, и выполнить в терминале:
              <br />
              <code className="mono chip" style={{ display: 'inline-block', marginTop: 4 }}>
                npx @plaud-ai/cli login
              </code>
            </li>
            <li>Откроется браузер — войти под своим обычным аккаунтом Plaud и разрешить доступ.</li>
            <li>
              После успеха открыть файл{' '}
              <code className="mono chip">~/.plaud/tokens.json</code>{' '}
              (в Windows — <code className="mono chip">%USERPROFILE%\.plaud\tokens.json</code>) и
              скопировать значение поля <code className="mono">refresh_token</code>.
            </li>
            <li>Вставить его в поле ниже.</li>
          </ol>

          <form onSubmit={connect} className="form-card" style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <label>
              Refresh token
              <input
                type="password"
                value={refreshToken}
                onChange={(e) => setRefreshToken(e.target.value)}
                placeholder="..."
                required
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={busy}>
              {busy ? 'Подключаем…' : 'Подключить'}
            </button>
          </form>
          <p className="hint" style={{ marginTop: 10 }}>
            Подробнее о самом CLI —{' '}
            <a href="https://docs.plaud.ai" target="_blank" rel="noreferrer">
              docs.plaud.ai <ExternalLink size={12} strokeWidth={2} style={{ verticalAlign: -1 }} />
            </a>
            .
          </p>
        </>
      )}
    </div>
  );
}

function MeetingsList() {
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MeetingSummary[]>('/meetings')
      .then(setMeetings)
      .catch(() => setError('Не удалось загрузить встречи'));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!meetings) return <p className="hint">Загрузка…</p>;
  if (meetings.length === 0) {
    return (
      <div className="empty-state">
        <strong>Встреч пока нет</strong>
        <p className="hint">Подключите Plaud выше, чтобы записи импортировались автоматически, или загрузите саммари вручную.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Встреча</th>
            <th>Дата</th>
            <th>Загрузил</th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((m) => (
            <tr key={m.id}>
              <td>
                <Link href={`/meetings/${m.id}`}>{m.title}</Link>
                {m.plaudRecordingId && <span className="badge badge-muted" style={{ marginLeft: 8 }}>Plaud</span>}
              </td>
              <td>{new Date(m.meetingDate).toLocaleDateString('ru-RU')}</td>
              <td>{m.createdBy.fullName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MeetingsPage() {
  return (
    <Protected requireRole="OWNER">
      <div className="page-header">
        <h1>Встречи</h1>
        <Link href="/meetings/new" className="btn">
          <Plus size={16} strokeWidth={2.5} />
          Загрузить встречу
        </Link>
      </div>
      <p className="page-subtitle">
        Саммари из Plaud — источник задач (раздел 8 ТЗ). Видит только руководитель: протокол может
        содержать переговоры и темы шире, чем задачи, которые из него извлечены.
      </p>
      <PlaudConnectionCard />
      <MeetingsList />
    </Protected>
  );
}

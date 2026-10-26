'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ExternalLink, Link2, Link2Off, Plus, RefreshCw } from 'lucide-react';
import type { MeetingSummary, PlaudStatus } from '@ai-task-system/shared-types';
import { MANAGER_ROLES } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { PageHeader } from '@/components/ui/card';
import { ConnectionBar } from '@/components/ui/connection-bar';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';

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
  const [setupOpen, setSetupOpen] = useState(false);

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

  if (status.connected) {
    return (
      <ConnectionBar
        on
        title="Plaud подключён — записи импортируются автоматически"
        meta={status.lastSyncAt ? `Обновлено ${new Date(status.lastSyncAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'}
        actions={
          <>
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => syncNow(() => window.location.reload())} disabled={busy}>
              Синхронизировать
            </Button>
            <Button variant="secondary" size="sm" icon={Link2Off} onClick={disconnect} disabled={busy}>
              Отключить
            </Button>
          </>
        }
      >
        {error && <Alert tone="danger">{error}</Alert>}
      </ConnectionBar>
    );
  }

  return (
    <ConnectionBar
      on={false}
      title="Plaud не подключён"
      meta="Записи можно загрузить вручную или подключить Plaud один раз"
      actions={
        !setupOpen && (
          <Button variant="secondary" size="sm" icon={Link2} onClick={() => setSetupOpen(true)}>
            Подключить
          </Button>
        )
      }
    >
      {setupOpen && (
        <div className="conn-bar-setup">
          <p className="panel-hint">У Plaud нет подключения через браузер для этого сценария — нужно один раз получить токен на своём компьютере:</p>
          <ol className="setup-steps">
            <li>
              Установить Node.js, если ещё не установлен, и выполнить в терминале: <code className="mono chip">npx @plaud-ai/cli login</code>
            </li>
            <li>Откроется браузер — войти под своим обычным аккаунтом Plaud и разрешить доступ.</li>
            <li>
              После успеха открыть файл <code className="mono chip">~/.plaud/tokens.json</code> (в Windows —{' '}
              <code className="mono chip">%USERPROFILE%\.plaud\tokens.json</code>) и скопировать значение поля <code className="mono">refresh_token</code>.
            </li>
            <li>
              Вставить его в поле ниже. Подробнее о CLI —{' '}
              <a href="https://docs.plaud.ai" target="_blank" rel="noreferrer">
                docs.plaud.ai <ExternalLink size={12} strokeWidth={1.75} />
              </a>
              .
            </li>
          </ol>
          <form onSubmit={connect}>
            <Field label="Refresh token">
              <Input type="password" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="..." required />
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="panel-actions">
              <Button type="submit" variant="primary" disabled={busy} loading={busy}>
                Подключить
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

function MeetingsList() {
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MeetingSummary[]>('/meetings')
      .then(setMeetings)
      .catch(() => setError('Не удалось загрузить встречи'));
  }, []);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!meetings) return <p className="ds-field-hint">Загрузка…</p>;
  if (meetings.length === 0) {
    return (
      <EmptyState title="Встреч пока нет" description="Записи Plaud появятся здесь автоматически; саммари можно загрузить и вручную." />
    );
  }

  return (
    <div className="ds-table-wrap">
      <table className="ds-table">
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
                <span className="row-item-title">
                  <Link href={`/meetings/${m.id}`}>{m.title}</Link>
                  {m.plaudRecordingId && <Badge>Plaud</Badge>}
                </span>
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
    <Protected requireRole={MANAGER_ROLES}>
      <PageHeader
        title="Встречи"
        description="Саммари встреч из Plaud — источник задач. Видит только руководство."
        actions={
          <Link href="/meetings/new" className="ds-btn ds-btn-primary">
            <Plus size={18} strokeWidth={1.75} />
            Загрузить встречу
          </Link>
        }
      />
      <PlaudConnectionCard />
      <MeetingsList />
    </Protected>
  );
}

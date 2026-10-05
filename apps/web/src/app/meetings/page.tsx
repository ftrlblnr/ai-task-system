'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ExternalLink, Link2, Link2Off, Plus, RefreshCw } from 'lucide-react';
import type { MeetingSummary, PlaudStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Card, PageHeader } from '@/components/ui/card';
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
    <Card style={{ marginBottom: 20 }}>
      {status.connected ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link2 size={16} strokeWidth={1.75} style={{ color: 'var(--ok)' }} />
          <span>Plaud подключён — записи импортируются автоматически.</span>
          <Badge>{status.lastSyncAt ? `Обновлено: ${new Date(status.lastSyncAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'}</Badge>
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => syncNow(() => window.location.reload())} disabled={busy}>
            Синхронизировать
          </Button>
          <Button variant="secondary" size="sm" icon={Link2Off} onClick={disconnect} disabled={busy}>
            Отключить
          </Button>
          {error && (
            <div style={{ width: '100%', marginTop: 4 }}>
              <Alert tone="danger">{error}</Alert>
            </div>
          )}
        </div>
      ) : (
        <>
          <h2 style={{ marginBottom: 8 }}>Plaud не подключён</h2>
          <p className="ds-field-hint" style={{ marginBottom: 14 }}>
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

          <form onSubmit={connect} style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--line)', maxWidth: 520 }}>
            <Field label="Refresh token">
              <Input type="password" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="..." required />
            </Field>
            {error && <Alert tone="danger">{error}</Alert>}
            <Button type="submit" variant="primary" disabled={busy} loading={busy} style={{ marginTop: 12 }}>
              Подключить
            </Button>
          </form>
          <p className="ds-field-hint" style={{ marginTop: 10 }}>
            Подробнее о самом CLI —{' '}
            <a href="https://docs.plaud.ai" target="_blank" rel="noreferrer">
              docs.plaud.ai <ExternalLink size={12} strokeWidth={1.75} style={{ verticalAlign: -1 }} />
            </a>
            .
          </p>
        </>
      )}
    </Card>
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
      <EmptyState title="Встреч пока нет" description="Подключите Plaud выше, чтобы записи импортировались автоматически, или загрузите саммари вручную." />
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
                <Link href={`/meetings/${m.id}`}>{m.title}</Link>
                {m.plaudRecordingId && (
                  <span style={{ marginLeft: 8 }}>
                    <Badge>Plaud</Badge>
                  </span>
                )}
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
      <PageHeader
        title="Встречи"
        description="Саммари из Plaud — источник задач (раздел 8 ТЗ). Видит только руководитель: протокол может содержать переговоры и темы шире, чем задачи, которые из него извлечены."
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

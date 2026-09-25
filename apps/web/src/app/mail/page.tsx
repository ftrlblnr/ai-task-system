'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link2Off, Paperclip, RefreshCw, Search } from 'lucide-react';
import type { EmailDetail, EmailListItem, EmailListResponse, EmailReplyStatus, MailStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';

// Stage 2, Phase R (Mail.ru Email Intelligence, 25.09.2026) — подключение ящика и
// просмотр локально синхронизированной почты. Только OWNER (как Plaud/календарь).
// Пароль приложения отправляется один раз и нигде не отображается.

const SYNC_POLL_MS = 5_000;

const ERROR_LABELS: Record<string, string> = {
  INVALID_CREDENTIALS: 'Неверный адрес или пароль приложения — подключите ящик заново.',
  IMAP_DISABLED: 'Доступ по IMAP выключен в настройках Mail.ru — включите его и подключите ящик заново.',
  TIMEOUT: 'Mail.ru не отвечает — повторим автоматически.',
  SYNC_FAILED: 'Синхронизация прервалась — повторим автоматически.',
  UNKNOWN: 'Не удалось подключиться к Mail.ru — повторим автоматически.',
};

const REPLY_STATUS_LABELS: Record<EmailReplyStatus, string> = {
  AWAITING_MY_REPLY: 'Ждёт вашего ответа',
  REPLIED: 'Вы ответили',
  NO_REPLY_REQUIRED: 'Ответ не нужен',
  AWAITING_THEIR_REPLY: 'Ждём ответ',
  UNKNOWN: '',
};

const IMPORTANCE_LABELS: Record<string, string> = { CRITICAL: 'Критично', IMPORTANT: 'Важно', NORMAL: '', LOW: '' };

type Filter = 'all' | 'unread' | 'awaiting' | 'important';

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

function senderLabel(m: { fromName: string | null; fromAddress: string }): string {
  return m.fromName?.trim() || m.fromAddress;
}

function ConnectCard({ onConnected }: { onConnected: () => void }) {
  const [emailAddress, setEmailAddress] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [initialDays, setInitialDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/mail/connect', { emailAddress, appPassword, initialDays });
      setAppPassword('');
      onConnected();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось подключить почту');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ marginBottom: 8 }}>Подключить Mail.ru</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        Письма синхронизируются в систему, а ассистент отвечает по ним из локальной базы. Нужен пароль для внешнего
        приложения — обычный пароль от почты не подойдёт.
      </p>
      <ol className="setup-steps">
        <li>В настройках Mail.ru включите доступ по IMAP (раздел «Почтовые программы»).</li>
        <li>В настройках безопасности аккаунта создайте «Пароль для внешнего приложения» и скопируйте его.</li>
        <li>Введите адрес ящика и этот пароль ниже. Пароль хранится только в зашифрованном виде.</li>
      </ol>
      <form onSubmit={connect} className="form-card" style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
        <label>
          Адрес почты
          <input type="email" value={emailAddress} onChange={(e) => setEmailAddress(e.target.value)} placeholder="name@mail.ru" required autoComplete="off" />
        </label>
        <label>
          Пароль приложения
          <input type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} required autoComplete="new-password" />
        </label>
        <label>
          Загрузить письма за
          <select value={initialDays} onChange={(e) => setInitialDays(Number(e.target.value))}>
            <option value={30}>30 дней</option>
            <option value={90}>90 дней</option>
            <option value={180}>180 дней</option>
          </select>
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Проверяем подключение…' : 'Подключить'}
        </button>
      </form>
    </div>
  );
}

function StatusBar({ status, onChange }: { status: Extract<MailStatus, { connected: true }>; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncing = status.syncState === 'SYNCING';

  async function syncNow() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/mail/sync');
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось запустить синхронизацию');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm('Отключить почту? Синхронизированные письма будут удалены из системы.')) return;
    setBusy(true);
    try {
      await api.delete('/mail/disconnect');
      onChange();
    } catch {
      setError('Не удалось отключить почту');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <strong>{status.emailAddress}</strong>
        <span className="badge badge-muted">{status.messageCount} писем</span>
        <span className="badge badge-muted">
          {syncing ? 'Синхронизация…' : status.lastSyncedAt ? `Обновлено: ${new Date(status.lastSyncedAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'}
        </span>
        <button className="btn-secondary btn-small" onClick={syncNow} disabled={busy || syncing || status.syncState === 'PAUSED'}>
          <RefreshCw size={14} strokeWidth={2} />
          Синхронизировать
        </button>
        <button className="btn-secondary btn-small" onClick={disconnect} disabled={busy}>
          <Link2Off size={14} strokeWidth={2} />
          Отключить
        </button>
      </div>
      {status.lastError && (
        <p className="error" style={{ marginTop: 8 }}>
          {status.syncState === 'PAUSED' ? 'Синхронизация приостановлена. ' : ''}
          {ERROR_LABELS[status.lastError] ?? 'Ошибка синхронизации.'}
        </p>
      )}
      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}

function MessageDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Состояние сбрасывается сменой key у родителя (см. MessageList) — не setState в эффекте.
  useEffect(() => {
    api
      .get<EmailDetail>(`/mail/messages/${id}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось открыть письмо'));
  }, [id]);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ marginBottom: 6 }}>{detail?.subject ?? 'Письмо'}</h2>
        <button className="btn-secondary btn-small" onClick={onClose}>
          Закрыть
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!detail && !error && <p className="hint">Загрузка…</p>}
      {detail && (
        <>
          <p className="hint" style={{ marginBottom: 8 }}>
            От: {senderLabel(detail)} &lt;{detail.fromAddress}&gt; · {formatDate(detail.receivedAt)}
            <br />
            Кому: {detail.recipients.filter((r) => r.type === 'TO').map((r) => r.name || r.address).join(', ') || '—'}
            {detail.recipients.some((r) => r.type === 'CC') && (
              <>
                <br />
                Копия: {detail.recipients.filter((r) => r.type === 'CC').map((r) => r.name || r.address).join(', ')}
              </>
            )}
          </p>
          {detail.analysis && (
            <p style={{ marginBottom: 10 }}>
              <strong>{IMPORTANCE_LABELS[detail.analysis.importance] || 'Кратко'}:</strong> {detail.analysis.summary}
              {detail.analysis.actionSummary && (
                <>
                  <br />
                  <strong>Действие:</strong> {detail.analysis.actionSummary}
                </>
              )}
            </p>
          )}
          {detail.attachments.length > 0 && (
            <p style={{ marginBottom: 10 }}>
              <Paperclip size={13} strokeWidth={2} style={{ verticalAlign: -2 }} /> {detail.attachments.map((a) => a.fileName).join(', ')}
            </p>
          )}
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0, maxHeight: 420, overflow: 'auto' }}>
            {detail.textBody ?? '(тело письма недоступно)'}
          </pre>
          {detail.bodyTruncated && <p className="hint">Письмо большое — показано начало.</p>}
          {detail.threadMessages.length > 1 && (
            <>
              <h3 style={{ margin: '16px 0 6px' }}>Переписка ({detail.threadMessages.length})</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {detail.threadMessages.map((t) => (
                  <li key={t.id} style={{ fontWeight: t.id === detail.id ? 600 : 400 }}>
                    {formatDate(t.receivedAt)} — {t.isOutgoing ? 'Вы' : senderLabel(t)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

function MessageList() {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [data, setData] = useState<EmailListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: '30' });
    if (filter === 'unread') params.set('readStatus', 'unread');
    if (filter === 'awaiting') params.set('replyStatus', 'AWAITING_MY_REPLY');
    if (filter === 'important') params.set('importance', 'CRITICAL,IMPORTANT');
    if (submittedQuery) params.set('q', submittedQuery);
    api
      .get<EmailListResponse>(`/mail/messages?${params.toString()}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить письма'));
  }, [filter, submittedQuery]);

  useEffect(load, [load]);

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'Все' },
    { key: 'unread', label: 'Непрочитанные' },
    { key: 'awaiting', label: 'Ждут ответа' },
    { key: 'important', label: 'Важные' },
  ];

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {filters.map((f) => (
          <button key={f.key} className={filter === f.key ? 'btn btn-small' : 'btn-secondary btn-small'} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedQuery(query.trim());
          }}
          style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}
        >
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по письмам" style={{ minWidth: 220 }} />
          <button type="submit" className="btn-secondary btn-small" aria-label="Искать">
            <Search size={14} strokeWidth={2} />
          </button>
        </form>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="hint">Загрузка…</p>}
      {data && data.items.length === 0 && (
        <div className="empty-state">
          <strong>Писем не найдено</strong>
          <p className="hint">Если ящик только что подключён, первая синхронизация может занять несколько минут.</p>
        </div>
      )}
      {data && data.items.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>От</th>
                <th>Тема</th>
                <th>Дата</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m: EmailListItem) => {
                const replyLabel = m.thread ? REPLY_STATUS_LABELS[m.thread.replyStatus] : '';
                const importanceLabel = m.analysis ? IMPORTANCE_LABELS[m.analysis.importance] : '';
                return (
                  <tr key={m.id} onClick={() => setOpenId(m.id)} style={{ cursor: 'pointer', fontWeight: m.isRead ? 400 : 600 }}>
                    <td>{senderLabel(m)}</td>
                    <td>
                      {m.subject || '(без темы)'}
                      {m.hasAttachments && <Paperclip size={12} strokeWidth={2} style={{ marginLeft: 6, verticalAlign: -1 }} />}
                      {importanceLabel && <span className="badge badge-muted" style={{ marginLeft: 8 }}>{importanceLabel}</span>}
                      {replyLabel && <span className="badge badge-muted" style={{ marginLeft: 8 }}>{replyLabel}</span>}
                      {m.analysis?.summary && <div className="hint" style={{ fontWeight: 400 }}>{m.analysis.summary}</div>}
                    </td>
                    <td>{formatDate(m.receivedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.totalCount > data.items.length && <p className="hint" style={{ marginTop: 8 }}>Показано {data.items.length} из {data.totalCount}.</p>}
      {openId && <MessageDetail key={openId} id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function MailView() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<MailStatus>('/mail/status')
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch(() => setError('Не удалось проверить статус почты'));
  }, []);

  useEffect(load, [load]);

  // Пока идёт синхронизация — обновляем статус (счётчик писем растёт).
  const syncing = status?.connected === true && status.syncState === 'SYNCING';
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(load, SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [syncing, load]);

  if (error) return <p className="error">{error}</p>;
  if (!status) return <p className="hint">Загрузка…</p>;
  if (!status.connected) return <ConnectCard onConnected={load} />;

  return (
    <>
      <StatusBar status={status} onChange={load} />
      <MessageList />
    </>
  );
}

export default function MailPage() {
  return (
    <Protected requireRole="OWNER">
      <div className="page-header">
        <h1>Почта</h1>
      </div>
      <MailView />
    </Protected>
  );
}

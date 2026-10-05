'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, Link2Off, Paperclip, RefreshCw, Search } from 'lucide-react';
import type {
  EmailDetail,
  EmailListItem,
  EmailListResponse,
  EmailReplyStatus,
  MailDigestDetail,
  MailDigestEmailItem,
  MailDigestListItem,
  MailDigestListResponse,
  MailStatus,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Card, PageHeader } from '@/components/ui/card';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';

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

// Владелец 30.09.2026: цветовой индикатор в подписях писем — Важно/Критично
// красным-оранжевым, Вы ответили зелёным, Ответ не нужен/Не важно серым.
// Дизайн-система «Адъютант» (04.10.2026, шаг 4) — тон Badge вместо
// собственных badge-danger/badge-warn/badge-ok классов.
const REPLY_STATUS_BADGE_TONE: Record<EmailReplyStatus, BadgeTone> = {
  AWAITING_MY_REPLY: 'warn',
  REPLIED: 'ok',
  NO_REPLY_REQUIRED: 'neutral',
  AWAITING_THEIR_REPLY: 'neutral',
  UNKNOWN: 'neutral',
};

// NORMAL/LOW теперь тоже подписаны (владелец 30.09.2026: индикатор важности
// должен быть виден у каждого проанализированного письма, не только у
// критичных/важных).
const IMPORTANCE_LABELS: Record<string, string> = { CRITICAL: 'Критично', IMPORTANT: 'Важно', NORMAL: 'Обычно', LOW: 'Не важно' };
const IMPORTANCE_BADGE_TONE: Record<string, BadgeTone> = {
  CRITICAL: 'danger',
  IMPORTANT: 'warn',
  NORMAL: 'neutral',
  LOW: 'neutral',
};

type Filter = 'all' | 'unread' | 'awaiting' | 'important';

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

function senderLabel(m: { fromName: string | null; fromAddress: string }): string {
  return m.fromName?.trim() || m.fromAddress;
}

// Release 2 — вложение с сохранённым содержимым скачивается тем же
// приёмом, что assistant-message-part.tsx.FilePartView (авторизованный
// fetch → Blob → временный <a download>, обычная <a href> не отправит
// Bearer-токен). Без сохранённых байт (downloadable=false — не удалось
// сохранить при синке, или письмо ещё с релиза 1) — просто имя файла.
function AttachmentItem({ attachment }: { attachment: EmailDetail['attachments'][number] }) {
  const [downloading, setDownloading] = useState(false);

  if (!attachment.downloadable) {
    return <span>{attachment.fileName}</span>;
  }

  async function download() {
    setDownloading(true);
    try {
      const blob = await api.downloadBlob(`/mail/attachments/${attachment.id}/download`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={downloading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'none',
        border: 'none',
        padding: 0,
        font: 'inherit',
        color: 'var(--accent, inherit)',
        textDecoration: 'underline',
        cursor: downloading ? 'default' : 'pointer',
      }}
    >
      {attachment.fileName}
      <Download size={12} strokeWidth={2} />
    </button>
  );
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
    <Card title="Подключить Mail.ru">
      <p className="ds-field-hint" style={{ marginBottom: 12 }}>
        Письма синхронизируются в систему, а ассистент отвечает по ним из локальной базы. Нужен пароль для внешнего
        приложения — обычный пароль от почты не подойдёт.
      </p>
      <ol className="setup-steps">
        <li>В настройках Mail.ru включите доступ по IMAP (раздел «Почтовые программы»).</li>
        <li>В настройках безопасности аккаунта создайте «Пароль для внешнего приложения» и скопируйте его.</li>
        <li>Введите адрес ящика и этот пароль ниже. Пароль хранится только в зашифрованном виде.</li>
      </ol>
      <form onSubmit={connect} style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--line)', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Field label="Адрес почты">
          <Input type="email" value={emailAddress} onChange={(e) => setEmailAddress(e.target.value)} placeholder="name@mail.ru" required autoComplete="off" />
        </Field>
        <Field label="Пароль приложения">
          <Input type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} required autoComplete="new-password" />
        </Field>
        <Field label="Загрузить письма за">
          <Select
            value={String(initialDays)}
            onChange={(e) => setInitialDays(Number(e.target.value))}
            options={[
              { value: '30', label: '30 дней' },
              { value: '90', label: '90 дней' },
              { value: '180', label: '180 дней' },
            ]}
          />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" variant="primary" disabled={busy} loading={busy}>
          Подключить
        </Button>
      </form>
    </Card>
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
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <strong>{status.emailAddress}</strong>
        <Badge>{status.messageCount} писем</Badge>
        <Badge>{syncing ? 'Синхронизация…' : status.lastSyncedAt ? `Обновлено: ${new Date(status.lastSyncedAt).toLocaleString('ru-RU')}` : 'Ещё не синхронизировано'}</Badge>
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={syncNow} disabled={busy || syncing || status.syncState === 'PAUSED'}>
          Синхронизировать
        </Button>
        <Button variant="secondary" size="sm" icon={Link2Off} onClick={disconnect} disabled={busy}>
          Отключить
        </Button>
      </div>
      {status.lastError && (
        <div style={{ marginTop: 8 }}>
          <Alert tone="danger">
            {status.syncState === 'PAUSED' ? 'Синхронизация приостановлена. ' : ''}
            {ERROR_LABELS[status.lastError] ?? 'Ошибка синхронизации.'}
          </Alert>
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
    <Card style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ marginBottom: 6 }}>{detail?.subject ?? 'Письмо'}</h2>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Закрыть
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!detail && !error && <p className="ds-field-hint">Загрузка…</p>}
      {detail && (
        <>
          <p className="ds-field-hint" style={{ marginBottom: 8 }}>
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
              <strong>{(detail.analysis.importance && IMPORTANCE_LABELS[detail.analysis.importance]) || 'Кратко'}:</strong> {detail.analysis.summary}
              {detail.analysis.actionSummary && (
                <>
                  <br />
                  <strong>Действие:</strong> {detail.analysis.actionSummary}
                </>
              )}
            </p>
          )}
          {detail.attachments.length > 0 && (
            <p style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Paperclip size={13} strokeWidth={1.75} style={{ verticalAlign: -2 }} />
              {detail.attachments.map((a, i) => (
                <span key={a.id}>
                  <AttachmentItem attachment={a} />
                  {i < detail.attachments.length - 1 && ','}
                </span>
              ))}
            </p>
          )}
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0, maxHeight: 420, overflow: 'auto' }}>
            {detail.textBody ?? '(тело письма недоступно)'}
          </pre>
          {detail.bodyTruncated && <p className="ds-field-hint">Письмо большое — показано начало.</p>}
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
    </Card>
  );
}

function MessageList() {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [data, setData] = useState<EmailListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Переключение вкладки/поиска до того, как ответил предыдущий запрос,
  // могло применить более старый ответ (пришёл позже из-за сети), если он
  // разрешился ПОСЛЕ нового — список тогда показывал письма не той вкладки
  // (например, "Ответ не нужен" под вкладкой «Ждут ответа»). requestId —
  // применяем только самый свежий по порядку запуска ответ.
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    const params = new URLSearchParams({ limit: '30' });
    if (filter === 'unread') params.set('readStatus', 'unread');
    if (filter === 'awaiting') params.set('replyStatus', 'AWAITING_MY_REPLY');
    if (filter === 'important') params.set('importance', 'CRITICAL,IMPORTANT');
    if (submittedQuery) params.set('q', submittedQuery);
    api
      .get<EmailListResponse>(`/mail/messages?${params.toString()}`)
      .then((r) => {
        if (requestId !== requestIdRef.current) return;
        setData(r);
        setError(null);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить письма');
      });
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
        <SegmentedControl
          options={filters.map((f) => ({ value: f.key, label: f.label }))}
          value={filter}
          onChange={(v) => {
            setFilter(v as Filter);
            setOpenId(null);
          }}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedQuery(query.trim());
            setOpenId(null);
          }}
          style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}
        >
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по письмам" style={{ minWidth: 220 }} />
          <IconButton icon={Search} label="Искать" variant="outline" size="sm" type="submit" />
        </form>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <p className="ds-field-hint">Загрузка…</p>}
      {data && data.items.length === 0 && (
        <EmptyState title="Писем не найдено" description="Если ящик только что подключён, первая синхронизация может занять несколько минут." />
      )}
      {data && data.items.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table">
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
                const importanceLabel = m.analysis?.importance ? IMPORTANCE_LABELS[m.analysis.importance] : '';
                return (
                  <tr key={m.id} onClick={() => setOpenId(m.id)} style={{ cursor: 'pointer', fontWeight: m.isRead ? 400 : 600 }}>
                    <td>{senderLabel(m)}</td>
                    <td>
                      {m.subject || '(без темы)'}
                      {m.hasAttachments && <Paperclip size={12} strokeWidth={1.75} style={{ marginLeft: 6, verticalAlign: -1 }} />}
                      {importanceLabel && m.analysis?.importance && (
                        <span style={{ marginLeft: 8 }}>
                          <Badge tone={IMPORTANCE_BADGE_TONE[m.analysis.importance]}>{importanceLabel}</Badge>
                        </span>
                      )}
                      {replyLabel && m.thread && (
                        <span style={{ marginLeft: 8 }}>
                          <Badge tone={REPLY_STATUS_BADGE_TONE[m.thread.replyStatus]}>{replyLabel}</Badge>
                        </span>
                      )}
                      {m.analysis?.summary && <div className="ds-field-hint" style={{ fontWeight: 400 }}>{m.analysis.summary}</div>}
                    </td>
                    <td>{formatDate(m.receivedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.totalCount > data.items.length && (
        <p className="ds-field-hint" style={{ marginTop: 8 }}>
          Показано {data.items.length} из {data.totalCount}.
        </p>
      )}
      {openId && <MessageDetail key={openId} id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function formatDay(value: string): string {
  return new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function digestItemBadges(item: Pick<MailDigestEmailItem, 'analysis'>): string[] {
  const badges: string[] = [];
  if (item.analysis?.status === 'COMPLETED') {
    const label = item.analysis.importance ? IMPORTANCE_LABELS[item.analysis.importance] : '';
    if (label) badges.push(label);
    if (item.analysis.needsReply) badges.push('нужен ответ');
    if (item.analysis.needsAction) badges.push('нужно действие');
  }
  return badges;
}

function DigestDetailView({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<MailDigestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MailDigestDetail>(`/mail/digests/${id}`)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось открыть сводку'));
  }, [id]);

  return (
    <Card style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ marginBottom: 6 }}>{detail ? `Сводка за ${formatDay(detail.periodFrom)}` : 'Сводка'}</h2>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Закрыть
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!detail && !error && <p className="ds-field-hint">Загрузка…</p>}
      {detail && (
        <>
          <p className="ds-field-hint" style={{ marginBottom: 12 }}>
            Источник: {detail.source}
          </p>
          {detail.items.length === 0 && <p className="ds-field-hint">Писем за эти сутки не было.</p>}
          {detail.items.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {detail.items.map((item, i) => {
                const badges = digestItemBadges(item);
                return (
                  <li key={item.id ?? i} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 10 }}>
                    <div>
                      <span className="ds-field-hint">{formatDate(item.receivedAt)}</span>{' '}
                      <strong>{item.fromName || item.fromAddress}</strong> — {item.subject || '(без темы)'}
                      {badges.map((b) => (
                        <span key={b} style={{ marginLeft: 8 }}>
                          <Badge>{b}</Badge>
                        </span>
                      ))}
                    </div>
                    {item.analysis?.summary && <div className="ds-field-hint">{item.analysis.summary}</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function DigestList() {
  const [data, setData] = useState<MailDigestListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MailDigestListResponse>('/mail/digests')
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить сводки'));
  }, []);

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <p className="ds-field-hint">Загрузка…</p>}
      {data && data.digests.length === 0 && (
        <EmptyState title="Сводок пока нет" description="Первая ежедневная сводка появится завтра в 06:00 по Алматы." />
      )}
      {data && data.digests.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Источник</th>
                <th>Писем</th>
              </tr>
            </thead>
            <tbody>
              {data.digests.map((d: MailDigestListItem) => (
                <tr key={d.id} onClick={() => setOpenId(d.id)} style={{ cursor: 'pointer' }}>
                  <td>{formatDay(d.periodFrom)}</td>
                  <td>{data.source}</td>
                  <td>
                    {d.totalCount}
                    {d.importantCount > 0 && (
                      <span style={{ marginLeft: 8 }}>
                        <Badge>важных: {d.importantCount}</Badge>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <DigestDetailView key={openId} id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

type MailTab = 'messages' | 'digests';

function MailView() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<MailTab>('messages');

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

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!status) return <p className="ds-field-hint">Загрузка…</p>;
  if (!status.connected) return <ConnectCard onConnected={load} />;

  return (
    <>
      <StatusBar status={status} onChange={load} />
      <div style={{ marginBottom: 16 }}>
        <SegmentedControl
          options={[
            { value: 'messages', label: 'Письма' },
            { value: 'digests', label: 'Дайджест' },
          ]}
          value={tab}
          onChange={(v) => setTab(v as MailTab)}
        />
      </div>
      {tab === 'messages' ? <MessageList /> : <DigestList />}
    </>
  );
}

export default function MailPage() {
  return (
    <Protected requireRole="OWNER">
      <PageHeader title="Почта" />
      <MailView />
    </Protected>
  );
}

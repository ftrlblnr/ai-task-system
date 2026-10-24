'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Flag, Mail, Paperclip, RefreshCw } from 'lucide-react';
import type { EmailListItem, EmailListResponse, MailFolderItem, MailFolderRole, MailStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { companyDate, companyDayKey, companyTime } from '@/lib/company-time';
import { loadPref, savePref } from '@/lib/telegram';
import { Alert, Button, EmptyState, IconButton, ScreenHeader, SearchInput, Select, Skeleton, cx } from '@/components/ui';
import { MailMessageOverlay } from './mail-message-overlay';

// Почта в Mini App (владелец 24.10.2026: «в мини апп нет почты») — те же
// эндпоинты, что web /mail: ящик, папки, фильтры, поиск, письмо с действиями.
// Подключение ящика и письма с нуля — в web; ответ готовит ассистент (почта,
// этап 3: черновик в чате, отправка только по кнопке).

const PAGE_SIZE = 30;
const SYNC_POLL_MS = 5_000;
const MAILBOX_PREF = 'mail_mailbox';

type Filter = 'all' | 'awaiting' | 'unread' | 'important' | 'flagged';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'awaiting', label: 'Ждут ответа' },
  { key: 'unread', label: 'Непрочитанные' },
  { key: 'important', label: 'Важные' },
  { key: 'flagged', label: 'С флажком' },
];

const ROLE_ORDER: MailFolderRole[] = ['INBOX', 'DRAFTS', 'SENT', 'ARCHIVE', 'JUNK', 'TRASH'];
const ROLE_LABELS: Record<MailFolderRole, string> = {
  INBOX: 'Входящие',
  DRAFTS: 'Черновики',
  SENT: 'Отправленные',
  ARCHIVE: 'Архив',
  JUNK: 'Спам',
  TRASH: 'Корзина',
  OTHER: '',
};

export function folderLabel(f: MailFolderItem): string {
  return ROLE_LABELS[f.role] || (f.delimiter ? f.path.split(f.delimiter).at(-1) : f.path) || f.path;
}

function sortFolders(folders: MailFolderItem[]): MailFolderItem[] {
  const system = ROLE_ORDER.flatMap((role) => folders.filter((f) => f.role === role));
  const own = folders.filter((f) => f.role === 'OTHER').sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  return [...system, ...own];
}

export function senderLabel(m: { fromName: string | null; fromAddress: string }): string {
  return m.fromName || m.fromAddress;
}

// Сегодня — время, раньше — дата (по времени компании).
function shortDate(value: string | null): string {
  if (!value) return '';
  return companyDayKey(value) === companyDayKey(new Date()) ? companyTime(value) : companyDate(value);
}

export function MailScreen({ active = true }: { active?: boolean }) {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [mailboxId, setMailboxId] = useState<string | null>(null);
  const [folders, setFolders] = useState<MailFolderItem[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [list, setList] = useState<EmailListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // Свежий ответ побеждает: быстрое переключение фильтров не должно показать
  // список предыдущего фильтра, пришедший позже (тот же приём, что в web).
  const requestIdRef = useRef(0);

  const mailboxes = status?.mailboxes ?? [];
  const mailbox = mailboxes.find((m) => m.id === mailboxId) ?? null;

  const loadStatus = useCallback(() => {
    api
      .get<MailStatus>('/mail/status')
      .then((s) => {
        setStatus(s);
        setError(null);
        void loadPref(MAILBOX_PREF).then((saved) => {
          setMailboxId((cur) => {
            if (cur && s.mailboxes.some((m) => m.id === cur)) return cur;
            return s.mailboxes.find((m) => m.id === saved)?.id ?? s.mailboxes[0]?.id ?? null;
          });
        });
      })
      .catch(() => setError('Не удалось проверить почту'));
  }, []);

  useEffect(() => {
    if (active) loadStatus();
  }, [active, loadStatus]);

  // Пока ящик синхронизируется — обновляем статус и список.
  const syncing = mailbox?.syncState === 'SYNCING';
  useEffect(() => {
    if (!syncing || !active) return;
    const timer = setInterval(loadStatus, SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [syncing, active, loadStatus]);

  const loadFolders = useCallback(() => {
    if (!mailboxId) return;
    api
      .get<MailFolderItem[]>('/mail/folder-tree', { 'X-Mailbox-Id': mailboxId })
      .then((f) => {
        setFolders(sortFolders(f));
        setFolderId((cur) => (cur && f.some((x) => x.id === cur) ? cur : (f.find((x) => x.role === 'INBOX')?.id ?? null)));
      })
      .catch(() => setFolders([]));
  }, [mailboxId]);

  useEffect(() => {
    if (active) loadFolders();
  }, [active, loadFolders]);

  const q = query.trim();
  const loadList = useCallback(() => {
    if (!mailboxId) return;
    const requestId = ++requestIdRef.current;
    const params = new URLSearchParams({ limit: String(limit) });
    if (filter === 'unread') params.set('readStatus', 'unread');
    if (filter === 'awaiting') params.set('replyStatus', 'AWAITING_MY_REPLY');
    if (filter === 'important') params.set('importance', 'CRITICAL,IMPORTANT');
    if (filter === 'flagged') params.set('flagged', 'true');
    // Поиск — по всем папкам, кроме Спама и Корзины, как в web.
    if (q) {
      params.set('q', q);
      params.set('direction', 'all');
    } else if (folderId) {
      params.set('folderId', folderId);
    }
    api
      .get<EmailListResponse>(`/mail/messages?${params.toString()}`, { 'X-Mailbox-Id': mailboxId })
      .then((r) => {
        if (requestId !== requestIdRef.current) return;
        setList(r);
        setError(null);
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить письма');
      });
  }, [mailboxId, folderId, filter, q, limit]);

  useEffect(() => {
    if (active) loadList();
  }, [active, loadList, mailbox?.messageCount]);

  function selectMailbox(id: string) {
    setMailboxId(id);
    setFolderId(null);
    setList(null);
    savePref(MAILBOX_PREF, id);
  }

  async function syncNow() {
    if (!mailboxId) return;
    await api.post('/mail/sync', {}, { 'X-Mailbox-Id': mailboxId }).catch(() => undefined);
    loadStatus();
  }

  function refreshAll() {
    loadList();
    loadFolders();
  }

  const folder = folders.find((f) => f.id === folderId) ?? null;
  const kicker = mailbox
    ? syncing
      ? 'Синхронизация…'
      : folder && folder.unreadCount > 0
        ? `${folderLabel(folder)} · ${folder.unreadCount} непрочитанных`
        : mailbox.emailAddress
    : undefined;

  if (status && mailboxes.length === 0) {
    return (
      <div>
        <ScreenHeader title="Почта" />
        <EmptyState icon={Mail} title="Почта не подключена" description="Подключите ящик в веб-версии Адъютанта — здесь появятся письма." />
      </div>
    );
  }

  return (
    <div>
      <ScreenHeader
        kicker={kicker}
        title="Почта"
        action={<IconButton icon={RefreshCw} label="Обновить почту" variant="ghost" onClick={() => void syncNow()} disabled={!mailboxId || syncing} />}
      />

      {mailboxes.length > 1 && (
        <Select
          aria-label="Ящик"
          className="mail-select"
          value={mailboxId ?? ''}
          onChange={(e) => selectMailbox(e.target.value)}
          options={mailboxes.map((m) => ({ value: m.id, label: m.emailAddress }))}
        />
      )}

      <div className="mail-controls">
        <SearchInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по письмам" aria-label="Поиск по письмам" />
        {!q && folders.length > 0 && (
          <Select
            aria-label="Папка"
            className="mail-select"
            value={folderId ?? ''}
            onChange={(e) => {
              setFolderId(e.target.value);
              setLimit(PAGE_SIZE);
            }}
            options={folders.map((f) => ({ value: f.id, label: f.unreadCount > 0 ? `${folderLabel(f)} · ${f.unreadCount}` : folderLabel(f) }))}
          />
        )}
      </div>

      <div className="filter-chips" role="tablist" aria-label="Фильтр писем">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className={cx('filter-chip', filter === f.key && 'is-active')}
            onClick={() => {
              setFilter(f.key);
              setLimit(PAGE_SIZE);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {!list ? (
        <div className="list-card">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="mail-row">
              <Skeleton height={14} width="60%" />
              <Skeleton height={12} width="85%" />
            </div>
          ))}
        </div>
      ) : list.items.length === 0 ? (
        <div className="attention-empty">{q ? 'Ничего не найдено' : filter === 'all' ? 'Писем нет' : 'Таких писем нет'}</div>
      ) : (
        <>
          <div className="list-card">
            {list.items.map((m) => (
              <MailRow key={m.id} message={m} onOpen={() => setOpenId(m.id)} />
            ))}
          </div>
          {list.totalCount > list.items.length && (
            <Button variant="secondary" block className="mail-more" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
              Показать ещё
            </Button>
          )}
        </>
      )}

      {openId && mailboxId && (
        <MailMessageOverlay
          id={openId}
          mailboxId={mailboxId}
          folders={folders}
          onChanged={refreshAll}
          onClose={() => {
            setOpenId(null);
            refreshAll();
          }}
        />
      )}
    </div>
  );
}

function MailRow({ message: m, onOpen }: { message: EmailListItem; onOpen: () => void }) {
  const outgoing = m.isOutgoing;
  const who = outgoing ? `Кому: ${m.recipients[0]?.name || m.recipients[0]?.address || '—'}` : senderLabel(m);
  return (
    <button type="button" className={cx('mail-row', !m.isRead && 'is-unread')} onClick={onOpen}>
      <span className="mail-row-top">
        {!m.isRead && <span className="mail-dot" aria-label="Не прочитано" />}
        <span className="mail-row-from">{who}</span>
        {m.isFlagged && <Flag size={13} strokeWidth={2} className="mail-flag" aria-label="С флажком" />}
        {m.hasAttachments && <Paperclip size={13} strokeWidth={1.75} className="mail-clip" aria-label="Есть вложения" />}
        <span className="mail-row-date">{shortDate(m.receivedAt)}</span>
      </span>
      <span className="mail-row-subject">{m.subject || '(без темы)'}</span>
      {m.analysis?.summary && <span className="mail-row-summary">{m.analysis.summary}</span>}
    </button>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Flag, Mail, MailOpen, Paperclip, PenSquare, Reply, Search, Trash2 } from 'lucide-react';
import type { EmailListItem, EmailListResponse, MailDraftView, MailFolderItem, MailMessageAction } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { FolderList, folderLabel } from './folder-list';
import { ComposePanel } from './compose-panel';
import { MessageDetail } from './message-detail';
import { IMPORTANCE_BADGE_TONE, IMPORTANCE_LABELS, REPLY_STATUS_BADGE_TONE, REPLY_STATUS_LABELS, formatDate, senderLabel } from './mail-labels';
import { createDraft, MoveSelect, runMessageAction, type MailPaneContext } from './message-actions';

// Вкладка «Письма»: папки слева, список и открытое письмо справа, новое
// письмо. Вынесено из app/mail/page.tsx (редизайн web W0).

type Filter = 'all' | 'unread' | 'flagged' | 'awaiting' | 'important';

const PAGE_SIZE = 30;

function MessageList({ folder, query, ctx, reloadKey }: { folder: MailFolderItem | null; query: string; ctx: MailPaneContext; reloadKey: number }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<EmailListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  // Переключение вкладки/поиска до того, как ответил предыдущий запрос,
  // могло применить более старый ответ (пришёл позже из-за сети), если он
  // разрешился ПОСЛЕ нового — список тогда показывал письма не той вкладки
  // (например, "Ответ не нужен" под вкладкой «Ждут ответа»). requestId —
  // применяем только самый свежий по порядку запуска ответ.
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    const params = new URLSearchParams({ limit: String(limit) });
    if (filter === 'unread') params.set('readStatus', 'unread');
    if (filter === 'awaiting') params.set('replyStatus', 'AWAITING_MY_REPLY');
    if (filter === 'important') params.set('importance', 'CRITICAL,IMPORTANT');
    if (filter === 'flagged') params.set('flagged', 'true');
    // Поиск — по всем папкам (кроме Спама и Корзины), как в Outlook.
    if (query) {
      params.set('q', query);
      params.set('direction', 'all');
    } else if (folder) {
      params.set('folderId', folder.id);
    }
    api
      .get<EmailListResponse>(`/mail/messages?${params.toString()}`)
      .then((r) => {
        if (requestId !== requestIdRef.current) return;
        setData(r);
        setError(null);
        setSelected((cur) => new Set(r.items.filter((i) => cur.has(i.id)).map((i) => i.id)));
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof ApiError ? err.message : 'Не удалось загрузить письма');
      });
  }, [filter, query, folder, limit]);

  useEffect(load, [load, reloadKey]);
  const outgoingFolder = !query && (folder?.role === 'SENT' || folder?.role === 'DRAFTS');
  const inTrash = !query && (folder?.role === 'TRASH' || folder?.role === 'JUNK');
  const hasArchive = ctx.folders.some((f) => f.role === 'ARCHIVE');

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'Все' },
    { key: 'unread', label: 'Непрочитанные' },
    { key: 'flagged', label: 'С флажком' },
    { key: 'awaiting', label: 'Ждут ответа' },
    { key: 'important', label: 'Важные' },
  ];

  async function bulk(action: MailMessageAction) {
    if (action.type === 'delete' && !window.confirm(`Удалить навсегда писем: ${selected.size}? Восстановить их будет нельзя.`)) return;
    setBusy(true);
    const failure = await runMessageAction([...selected], action);
    setBusy(false);
    setError(failure);
    if (action.type !== 'read' && action.type !== 'flag') setSelected(new Set());
    if (openId && selected.has(openId) && action.type !== 'read' && action.type !== 'flag') setOpenId(null);
    load();
    ctx.onChanged();
  }

  async function toggleFlag(m: EmailListItem) {
    const failure = await runMessageAction([m.id], { type: 'flag', value: !m.isFlagged });
    if (failure) return setError(failure);
    setData((cur) => (cur ? { ...cur, items: cur.items.map((i) => (i.id === m.id ? { ...i, isFlagged: !m.isFlagged } : i)) } : cur));
  }

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = Boolean(data && data.items.length > 0 && data.items.every((i) => selected.has(i.id)));
  const childCtx: MailPaneContext = {
    ...ctx,
    onChanged: () => {
      load();
      ctx.onChanged();
    },
  };

  return (
    <>
      <div className="mail-filters">
        <SegmentedControl
          options={filters.map((f) => ({ value: f.key, label: f.label }))}
          value={filter}
          onChange={(v) => {
            setFilter(v as Filter);
            setOpenId(null);
            setLimit(PAGE_SIZE);
          }}
        />
      </div>

      {selected.size > 0 && (
        <div className="mail-toolbar mail-bulk">
          <span>Выбрано: {selected.size}</span>
          <Button variant="ghost" size="sm" icon={MailOpen} onClick={() => bulk({ type: 'read', value: true })} disabled={busy}>
            Прочитано
          </Button>
          <Button variant="ghost" size="sm" icon={Mail} onClick={() => bulk({ type: 'read', value: false })} disabled={busy}>
            Не прочитано
          </Button>
          <Button variant="ghost" size="sm" icon={Flag} onClick={() => bulk({ type: 'flag', value: true })} disabled={busy}>
            Флажок
          </Button>
          {hasArchive && folder?.role !== 'ARCHIVE' && (
            <Button variant="ghost" size="sm" icon={Archive} onClick={() => bulk({ type: 'archive' })} disabled={busy}>
              В архив
            </Button>
          )}
          <Button variant="ghost" size="sm" icon={Trash2} onClick={() => bulk({ type: inTrash ? 'delete' : 'trash' })} disabled={busy}>
            {inTrash ? 'Удалить навсегда' : 'Удалить'}
          </Button>
          <MoveSelect folders={ctx.folders} currentId={query ? undefined : folder?.id} onMove={(folderId) => void bulk({ type: 'move', folderId })} disabled={busy} />
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}
      {!data && !error && <p className="ds-field-hint">Загрузка…</p>}
      {data && data.items.length === 0 && (
        <EmptyState
          title="Писем не найдено"
          description={query ? 'Поиск идёт по всем папкам, кроме «Спама» и «Корзины».' : 'Если ящик только что подключён, первая синхронизация может занять несколько минут.'}
        />
      )}
      {data && data.items.length > 0 && (
        <div className="ds-table-wrap">
          <table className="ds-table mail-table">
            <thead>
              <tr>
                <th className="mail-col-check">
                  <input
                    type="checkbox"
                    aria-label="Выбрать все"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(data.items.map((i) => i.id)))}
                  />
                </th>
                <th>{outgoingFolder ? 'Кому' : 'От'}</th>
                <th>Тема</th>
                <th>Дата</th>
                <th className="mail-col-flag" aria-label="Флажок" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((m: EmailListItem) => {
                const replyLabel = m.thread ? REPLY_STATUS_LABELS[m.thread.replyStatus] : '';
                const importanceLabel = m.analysis?.importance ? IMPORTANCE_LABELS[m.analysis.importance] : '';
                return (
                  <tr key={m.id} onClick={() => setOpenId(m.id)} className={m.id === openId ? 'is-open' : undefined} style={{ cursor: 'pointer', fontWeight: m.isRead ? 400 : 600 }}>
                    <td className="mail-col-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label="Выбрать письмо" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                    </td>
                    <td>
                      {m.isAnswered && <Reply size={12} strokeWidth={1.75} style={{ marginRight: 4, verticalAlign: -1 }} aria-label="Отвечено" />}
                      {outgoingFolder ? m.recipients.map((r) => r.name || r.address).join(', ') || '—' : senderLabel(m)}
                    </td>
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
                    <td className="mail-col-flag" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className={`mail-flag${m.isFlagged ? ' mail-flag-on' : ''}`}
                        aria-label={m.isFlagged ? 'Снять флажок' : 'Пометить флажком'}
                        aria-pressed={m.isFlagged}
                        onClick={() => void toggleFlag(m)}
                      >
                        <Flag size={14} strokeWidth={1.75} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.totalCount > data.items.length && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <span className="ds-field-hint">
            Показано {data.items.length} из {data.totalCount}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
            Показать ещё
          </Button>
        </div>
      )}
      {openId && <MessageDetail key={openId} id={openId} ctx={childCtx} onClose={() => setOpenId(null)} />}
    </>
  );
}

// Неотправленные черновики почтового клиента — в папке «Черновики» сверху.
function LocalDrafts({ onOpen, reloadKey }: { onOpen: (id: string) => void; reloadKey: number }) {
  const [drafts, setDrafts] = useState<MailDraftView[]>([]);

  useEffect(() => {
    api
      .get<MailDraftView[]>('/mail/drafts')
      .then(setDrafts)
      .catch(() => setDrafts([]));
  }, [reloadKey]);

  if (drafts.length === 0) return null;
  return (
    <div className="ds-table-wrap" style={{ marginBottom: 16 }}>
      <table className="ds-table">
        <thead>
          <tr>
            <th>Кому</th>
            <th>Тема</th>
            <th>Изменён</th>
          </tr>
        </thead>
        <tbody>
          {drafts.map((d) => (
            <tr key={d.id} onClick={() => onOpen(d.id)} style={{ cursor: 'pointer' }}>
              <td>{d.to.join(', ') || '—'}</td>
              <td>
                {d.subject || '(без темы)'}
                {d.lastError && (
                  <span style={{ marginLeft: 8 }}>
                    <Badge tone="danger">Не отправлено</Badge>
                  </span>
                )}
              </td>
              <td>{formatDate(d.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Письма выбранного ящика: папки слева, список справа (владелец 23.10.2026).
export function MessagesPane() {
  const [folders, setFolders] = useState<MailFolderItem[] | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [composeId, setComposeId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFolders = useCallback(() => {
    api
      .get<MailFolderItem[]>('/mail/folder-tree')
      .then(setFolders)
      .catch(() => setFolders([]));
  }, []);
  useEffect(loadFolders, [loadFolders]);

  const selected = folders?.find((f) => f.id === folderId) ?? folders?.find((f) => f.role === 'INBOX') ?? null;
  const ctx: MailPaneContext = useMemo(
    () => ({
      folders: folders ?? [],
      onCompose: (id: string) => {
        setNotice(null);
        setComposeId(id);
      },
      onChanged: loadFolders,
    }),
    [folders, loadFolders],
  );

  async function newMessage() {
    setError(null);
    try {
      ctx.onCompose(await createDraft('NEW'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать письмо');
    }
  }

  function closeCompose() {
    setComposeId(null);
    setReloadKey((k) => k + 1);
  }

  return (
    <div className="mail-layout">
      <div>
        <Button variant="primary" icon={PenSquare} onClick={newMessage} style={{ width: '100%', marginBottom: 12 }}>
          Написать
        </Button>
        {folders && folders.length > 0 && (
          <FolderList
            folders={folders}
            selectedId={submittedQuery ? null : (selected?.id ?? null)}
            onSelect={(id) => {
              setFolderId(id);
              setComposeId(null);
              setSubmittedQuery('');
              setQuery('');
            }}
          />
        )}
      </div>
      <div>
        <div className="mail-pane-head">
          <h2 style={{ margin: 0 }}>{submittedQuery ? `Поиск: «${submittedQuery}»` : selected ? folderLabel(selected) : 'Письма'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSubmittedQuery(query.trim());
              setComposeId(null);
            }}
            style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}
          >
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по всей почте" style={{ minWidth: 220 }} />
            <IconButton icon={Search} label="Искать" variant="outline" size="sm" type="submit" />
          </form>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && (
          <div style={{ marginBottom: 12 }}>
            <Alert tone="ok">{notice}</Alert>
          </div>
        )}
        {composeId ? (
          <ComposePanel
            key={composeId}
            draftId={composeId}
            onClose={closeCompose}
            onSent={(r) => {
              closeCompose();
              loadFolders();
              setNotice(r.rejected.length ? `Письмо отправлено, но сервер не принял адреса: ${r.rejected.join(', ')}` : 'Письмо отправлено');
            }}
          />
        ) : (
          <>
            {!submittedQuery && selected?.role === 'DRAFTS' && <LocalDrafts onOpen={ctx.onCompose} reloadKey={reloadKey} />}
            <MessageList key={`${submittedQuery ? 'q' : (selected?.id ?? 'all')}:${submittedQuery}`} folder={selected} query={submittedQuery} ctx={ctx} reloadKey={reloadKey} />
          </>
        )}
      </div>
    </div>
  );
}

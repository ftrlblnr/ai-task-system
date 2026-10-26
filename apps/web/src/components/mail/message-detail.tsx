'use client';

import { useEffect, useState } from 'react';
import { Archive, Download, Flag, Forward, Mail, MailOpen, Paperclip, Reply, ReplyAll, Trash2, X } from 'lucide-react';
import type { EmailDetail, MailDraftMode, MailMessageAction } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { MessageBody } from './message-body';
import { IMPORTANCE_LABELS, formatDate, senderLabel } from './mail-labels';
import { createDraft, MoveSelect, runMessageAction, type MailPaneContext } from './message-actions';

// Открытое письмо: действия, вложения, тело, переписка. Вынесено из
// app/mail/page.tsx (редизайн web W0).

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

export function MessageDetail({ id, ctx, onClose }: { id: string; ctx: MailPaneContext; onClose: () => void }) {
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { onChanged } = ctx;

  // Состояние сбрасывается сменой key у родителя (см. MessageList) — не setState в эффекте.
  useEffect(() => {
    api
      .get<EmailDetail>(`/mail/messages/${id}`)
      .then((d) => {
        setDetail(d);
        // Открытое письмо — прочитано, как в Outlook.
        if (!d.isRead) {
          void runMessageAction([d.id], { type: 'read', value: true }).then((e) => {
            if (!e) {
              setDetail((cur) => (cur ? { ...cur, isRead: true } : cur));
              onChanged();
            }
          });
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось открыть письмо'));
  }, [id, onChanged]);

  async function act(action: MailMessageAction, closeAfter: boolean) {
    if (!detail) return;
    setBusy(true);
    setError(null);
    const failure = await runMessageAction([detail.id], action);
    setBusy(false);
    if (failure) return setError(failure);
    if (action.type === 'read') setDetail({ ...detail, isRead: action.value });
    if (action.type === 'flag') setDetail({ ...detail, isFlagged: action.value });
    onChanged();
    if (closeAfter) onClose();
  }

  async function reply(mode: MailDraftMode) {
    if (!detail) return;
    setBusy(true);
    try {
      ctx.onCompose(await createDraft(mode, detail.id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать письмо');
      setBusy(false);
    }
  }

  const inTrash = detail?.folder.role === 'TRASH' || detail?.folder.role === 'JUNK';

  return (
    <Card style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ marginBottom: 6 }}>{detail?.subject || (detail ? '(без темы)' : 'Письмо')}</h2>
        <IconButton icon={X} label="Закрыть" onClick={onClose} />
      </div>
      {detail && (
        <div className="mail-toolbar">
          <Button variant="secondary" size="sm" icon={Reply} onClick={() => reply('REPLY')} disabled={busy}>
            Ответить
          </Button>
          <Button variant="ghost" size="sm" icon={ReplyAll} onClick={() => reply('REPLY_ALL')} disabled={busy}>
            Ответить всем
          </Button>
          <Button variant="ghost" size="sm" icon={Forward} onClick={() => reply('FORWARD')} disabled={busy}>
            Переслать
          </Button>
          <span className="mail-toolbar-gap" />
          <IconButton
            icon={Flag}
            label={detail.isFlagged ? 'Снять флажок' : 'Пометить флажком'}
            className={detail.isFlagged ? 'mail-flag-on' : undefined}
            onClick={() => act({ type: 'flag', value: !detail.isFlagged }, false)}
            disabled={busy}
          />
          <IconButton
            icon={detail.isRead ? Mail : MailOpen}
            label={detail.isRead ? 'Отметить непрочитанным' : 'Отметить прочитанным'}
            onClick={() => act({ type: 'read', value: !detail.isRead }, false)}
            disabled={busy}
          />
          {detail.folder.role !== 'ARCHIVE' && ctx.folders.some((f) => f.role === 'ARCHIVE') && (
            <IconButton icon={Archive} label="В архив" onClick={() => act({ type: 'archive' }, true)} disabled={busy} />
          )}
          <IconButton
            icon={Trash2}
            label={inTrash ? 'Удалить навсегда' : 'Удалить'}
            onClick={() => {
              if (inTrash && !window.confirm('Удалить письмо навсегда? Восстановить его будет нельзя.')) return;
              void act({ type: inTrash ? 'delete' : 'trash' }, true);
            }}
            disabled={busy}
          />
          <MoveSelect folders={ctx.folders} currentId={detail.folder.id} onMove={(folderId) => void act({ type: 'move', folderId }, true)} disabled={busy} />
        </div>
      )}
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
          <MessageBody html={detail.htmlBody} text={detail.textBody} />
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

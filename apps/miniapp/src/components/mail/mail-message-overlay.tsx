'use client';

import { useEffect, useState } from 'react';
import { Archive, ArrowLeft, Flag, FolderInput, Mail, MailOpen, Paperclip, Reply, Trash2 } from 'lucide-react';
import type { EmailDetail, MailFolderItem, MailMessageAction, MailMessageActionResult } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { companyDate, companyTime } from '@/lib/company-time';
import { notificationHaptic } from '@/lib/telegram';
import { Alert, Button, IconButton, Select, useAppToast } from '@/components/ui';
import { OverlayPortal } from '../overlay-portal';
import { useAskAssistant } from '../app-shell';
import { MailBody } from './mail-body';
import { folderLabel, senderLabel } from './mail-screen';

// Письмо целиком (Mini App, 24.10.2026). «Ответить» — через ассистента: он
// готовит черновик карточкой в чате, отправка только по кнопке (почта, этап 3).
// Остальные действия — сразу на сервере, как в web (POST /mail/messages/actions).

const IMPORTANCE_LABELS: Record<string, string> = { CRITICAL: 'Критично', IMPORTANT: 'Важно', NORMAL: 'Кратко', LOW: 'Кратко' };

function fullDate(value: string | null): string {
  return value ? `${companyDate(value)}, ${companyTime(value)}` : '';
}

interface Props {
  id: string;
  mailboxId: string;
  folders: MailFolderItem[];
  onChanged: () => void;
  onClose: () => void;
}

export function MailMessageOverlay({ id, mailboxId, folders, onChanged, onClose }: Props) {
  const askAssistant = useAskAssistant();
  const [toast, showToast] = useAppToast();
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headers = { 'X-Mailbox-Id': mailboxId };

  async function run(action: MailMessageAction): Promise<string | null> {
    try {
      const res = await api.post<MailMessageActionResult>('/mail/messages/actions', { ids: [id], action }, headers);
      return res.failed[0]?.error ?? null;
    } catch (err) {
      return err instanceof ApiError ? err.message : 'Действие не выполнено';
    }
  }

  useEffect(() => {
    api
      .get<EmailDetail>(`/mail/messages/${id}`, { 'X-Mailbox-Id': mailboxId })
      .then((d) => {
        setDetail(d);
        // Открытое письмо — прочитано, как в web.
        if (!d.isRead) {
          void api
            .post<MailMessageActionResult>('/mail/messages/actions', { ids: [d.id], action: { type: 'read', value: true } }, { 'X-Mailbox-Id': mailboxId })
            .then((res) => {
              if (res.failed.length > 0) return;
              setDetail((cur) => (cur ? { ...cur, isRead: true } : cur));
              onChanged();
            })
            .catch(() => undefined);
        }
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось открыть письмо'));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- письмо грузим один раз на открытие
  }, [id, mailboxId]);

  async function act(action: MailMessageAction, done: string, closeAfter: boolean) {
    if (!detail) return;
    setBusy(true);
    setError(null);
    const failure = await run(action);
    setBusy(false);
    if (failure) {
      notificationHaptic('error');
      setError(failure);
      return;
    }
    notificationHaptic('success');
    if (action.type === 'read') setDetail({ ...detail, isRead: action.value });
    if (action.type === 'flag') setDetail({ ...detail, isFlagged: action.value });
    onChanged();
    if (closeAfter) onClose();
    else showToast(done);
  }

  function reply() {
    if (!detail) return;
    onClose();
    askAssistant(`Подготовь ответ на письмо «${detail.subject || 'без темы'}» от ${senderLabel(detail)}`);
  }

  const inTrash = detail?.folder.role === 'TRASH' || detail?.folder.role === 'JUNK';
  const hasArchive = folders.some((f) => f.role === 'ARCHIVE');
  const to = detail?.recipients.filter((r) => r.type === 'TO').map((r) => r.name || r.address) ?? [];
  const cc = detail?.recipients.filter((r) => r.type === 'CC').map((r) => r.name || r.address) ?? [];

  return (
    <OverlayPortal>
      <div className="overlay">
        <div className="overlay-header">
          <IconButton icon={ArrowLeft} label="Назад" variant="ghost" onClick={onClose} />
          <strong className="mail-overlay-title">{detail?.subject || (detail ? '(без темы)' : 'Письмо')}</strong>
        </div>
        <div className="overlay-body">
          {error && <Alert tone="danger">{error}</Alert>}
          {!detail && !error && <p className="ds-field-hint">Загрузка…</p>}
          {detail && (
            <>
              <div className="mail-meta">
                <strong>{senderLabel(detail)}</strong>
                <span>{detail.fromAddress}</span>
                <span>{fullDate(detail.receivedAt)}</span>
                {to.length > 0 && <span>Кому: {to.join(', ')}</span>}
                {cc.length > 0 && <span>Копия: {cc.join(', ')}</span>}
              </div>

              <div className="mail-actions">
                {!detail.isOutgoing && (
                  <Button variant="primary" className="mail-reply" icon={Reply} onClick={reply} disabled={busy}>
                    Ответить
                  </Button>
                )}
                <span className="ds-spacer" />
                <IconButton
                  icon={Flag}
                  label={detail.isFlagged ? 'Снять флажок' : 'Пометить флажком'}
                  className={detail.isFlagged ? 'mail-flag-on' : undefined}
                  onClick={() => void act({ type: 'flag', value: !detail.isFlagged }, detail.isFlagged ? 'Флажок снят' : 'Помечено флажком', false)}
                  disabled={busy}
                />
                <IconButton
                  icon={detail.isRead ? Mail : MailOpen}
                  label={detail.isRead ? 'Отметить непрочитанным' : 'Отметить прочитанным'}
                  onClick={() => void act({ type: 'read', value: !detail.isRead }, detail.isRead ? 'Отмечено непрочитанным' : 'Прочитано', false)}
                  disabled={busy}
                />
                {hasArchive && detail.folder.role !== 'ARCHIVE' && (
                  <IconButton icon={Archive} label="В архив" onClick={() => void act({ type: 'archive' }, 'В архиве', true)} disabled={busy} />
                )}
                <IconButton
                  icon={Trash2}
                  label={inTrash ? 'Удалить навсегда' : 'Удалить'}
                  onClick={() => {
                    if (inTrash && !window.confirm('Удалить письмо навсегда? Восстановить его будет нельзя.')) return;
                    void act({ type: inTrash ? 'delete' : 'trash' }, 'Удалено', true);
                  }}
                  disabled={busy}
                />
              </div>

              {folders.length > 1 && (
                <label className="mail-move">
                  <FolderInput size={16} strokeWidth={1.75} />
                  <Select
                    aria-label="Переместить в папку"
                    className="mail-select"
                    value=""
                    disabled={busy}
                    onChange={(e) => e.target.value && void act({ type: 'move', folderId: e.target.value }, 'Перемещено', true)}
                    options={[
                      { value: '', label: 'Переместить в папку…' },
                      ...folders.filter((f) => f.id !== detail.folder.id).map((f) => ({ value: f.id, label: folderLabel(f) })),
                    ]}
                  />
                </label>
              )}

              {detail.analysis?.summary && (
                <div className="mail-summary">
                  <span className="kicker">{(detail.analysis.importance && IMPORTANCE_LABELS[detail.analysis.importance]) || 'Кратко'}</span>
                  <p>{detail.analysis.summary}</p>
                  {detail.analysis.actionSummary && <p className="mail-summary-action">Нужно: {detail.analysis.actionSummary}</p>}
                </div>
              )}

              {detail.attachments.length > 0 && (
                <div className="mail-attachments">
                  {detail.attachments.map((a) => (
                    <AttachmentChip key={a.id} attachment={a} mailboxId={mailboxId} />
                  ))}
                </div>
              )}

              <MailBody html={detail.htmlBody} text={detail.textBody} />
              {detail.bodyTruncated && <p className="ds-field-hint">Письмо большое — показано начало.</p>}

              {detail.threadMessages.length > 1 && (
                <>
                  <h3 className="section-label">Переписка · {detail.threadMessages.length}</h3>
                  <ul className="mail-thread">
                    {detail.threadMessages.map((t) => (
                      <li key={t.id} className={t.id === detail.id ? 'is-current' : undefined}>
                        <span>{t.isOutgoing ? 'Вы' : senderLabel(t)}</span>
                        <span className="due">{fullDate(t.receivedAt)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {toast}
    </OverlayPortal>
  );
}

function AttachmentChip({ attachment, mailboxId }: { attachment: EmailDetail['attachments'][number]; mailboxId: string }) {
  const [busy, setBusy] = useState(false);
  if (!attachment.downloadable) {
    return (
      <span className="mail-attachment is-disabled">
        <Paperclip size={14} strokeWidth={1.75} />
        {attachment.fileName}
      </span>
    );
  }

  // fetch → Blob → временный <a download>: обычная ссылка не отправит токен.
  async function download() {
    setBusy(true);
    try {
      const blob = await api.downloadBlob(`/mail/attachments/${attachment.id}/download`, { 'X-Mailbox-Id': mailboxId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      notificationHaptic('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="mail-attachment" onClick={download} disabled={busy}>
      <Paperclip size={14} strokeWidth={1.75} />
      {attachment.fileName}
    </button>
  );
}

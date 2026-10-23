'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Paperclip, Send, Trash2, X } from 'lucide-react';
import type { MailDraftView, MailSendResult } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Input, Textarea } from '@/components/ui/field';
import { FileChip } from '@/components/ui/file-chip';

// Окно письма (владелец 23.10.2026): новое, ответ, ответ всем, пересылка.
// Черновик сохраняется на сервере сам (через секунду после правки), письмо
// уходит только по кнопке «Отправить».

const SAVE_DELAY_MS = 1_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const MODE_TITLES: Record<MailDraftView['mode'], string> = {
  NEW: 'Новое письмо',
  REPLY: 'Ответ',
  REPLY_ALL: 'Ответ всем',
  FORWARD: 'Пересылка',
};

type Fields = Pick<MailDraftView, 'to' | 'cc' | 'bcc' | 'subject' | 'body'>;

function splitAddresses(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatSize(bytes: number | null): string | undefined {
  if (bytes === null) return undefined;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

export function ComposePanel({ draftId, onClose, onSent }: { draftId: string; onClose: () => void; onSent: (result: MailSendResult) => void }) {
  const [draft, setDraft] = useState<MailDraftView | null>(null);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<MailDraftView>(`/mail/drafts/${draftId}`)
      .then((d) => {
        version.current = d.version;
        setDraft(d);
        setTo(d.to.join(', '));
        setCc(d.cc.join(', '));
        setBcc(d.bcc.join(', '));
        setShowCopies(d.cc.length > 0 || d.bcc.length > 0);
        setSubject(d.subject);
        setBody(d.body);
        if (d.lastError) setError(d.lastError);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось открыть черновик'));
  }, [draftId]);

  const save = useCallback(
    async (patch: Partial<Fields> & { fileIds?: string[]; forwardAttachmentIds?: string[] }) => {
      // Сохранения идут по очереди: версия черновика растёт на каждое.
      await saving.current;
      const run = (async () => {
        setSaveState('saving');
        try {
          const res = await api.patch<{ version: number }>(`/mail/drafts/${draftId}`, { version: version.current, ...patch });
          version.current = res.version;
          setSaveState('saved');
        } catch (err) {
          setSaveState('dirty');
          setError(err instanceof ApiError ? err.message : 'Черновик не сохранился');
          throw err;
        }
      })();
      saving.current = run.catch(() => undefined);
      return run;
    },
    [draftId],
  );

  const fields = useCallback((): Fields => ({ to: splitAddresses(to), cc: splitAddresses(cc), bcc: splitAddresses(bcc), subject, body }), [to, cc, bcc, subject, body]);

  // Автосохранение через секунду после последней правки.
  useEffect(() => {
    if (!draft || saveState !== 'dirty') return;
    timer.current = setTimeout(() => void save(fields()).catch(() => undefined), SAVE_DELAY_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draft, saveState, fields, save]);

  function edit<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setSaveState('dirty');
      setError(null);
    };
  }

  async function addFiles(list: FileList | null) {
    if (!list || !draft) return;
    setError(null);
    const uploaded: MailDraftView['attachments'] = [];
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        if (file.size > MAX_FILE_BYTES) {
          setError(`«${file.name}» больше 20 МБ — такие файлы почтой не проходят`);
          continue;
        }
        const form = new FormData();
        form.append('file', file);
        const res = await api.postForm<{ fileId: string; name: string; size: number }>('/mail/attachments', form);
        uploaded.push({ id: res.fileId, kind: 'file', fileName: res.name, sizeBytes: res.size });
      }
      if (uploaded.length > 0) await updateAttachments([...draft.attachments, ...uploaded]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось прикрепить файл');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function updateAttachments(next: MailDraftView['attachments']) {
    if (!draft) return;
    await save({
      fileIds: next.filter((a) => a.kind === 'file').map((a) => a.id),
      forwardAttachmentIds: next.filter((a) => a.kind === 'forward').map((a) => a.id),
    });
    setDraft({ ...draft, attachments: next });
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      if (timer.current) clearTimeout(timer.current);
      await save(fields());
      const result = await api.post<MailSendResult>(`/mail/drafts/${draftId}/send`);
      onSent(result);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      // Отправка не прошла — черновик снова доступен для правки (версия выросла).
      const fresh = await api.get<MailDraftView>(`/mail/drafts/${draftId}`).catch(() => null);
      if (fresh) version.current = fresh.version;
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!window.confirm('Удалить черновик?')) return;
    setBusy(true);
    try {
      if (timer.current) clearTimeout(timer.current);
      await saving.current;
      await api.delete(`/mail/drafts/${draftId}`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить черновик');
      setBusy(false);
    }
  }

  async function close() {
    if (timer.current) clearTimeout(timer.current);
    if (saveState === 'dirty') await save(fields()).catch(() => undefined);
    onClose();
  }

  if (!draft) {
    return <Card>{error ? <Alert tone="danger">{error}</Alert> : <p className="ds-field-hint">Загрузка…</p>}</Card>;
  }

  return (
    <Card
      title={MODE_TITLES[draft.mode]}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="ds-field-hint">{saveState === 'saving' ? 'Сохраняю…' : saveState === 'saved' ? 'Черновик сохранён' : ''}</span>
          <IconButton icon={X} label="Закрыть (черновик сохранится)" onClick={close} disabled={busy} />
        </div>
      }
    >
      <div className="mail-compose">
        <label className="mail-compose-row">
          <span>Кому</span>
          <Input value={to} onChange={(e) => edit(setTo)(e.target.value)} placeholder="адрес@пример.kz, ещё@пример.kz" autoFocus={draft.mode !== 'REPLY' && draft.mode !== 'REPLY_ALL'} />
          {!showCopies && (
            <Button variant="ghost" size="sm" onClick={() => setShowCopies(true)}>
              Копия
            </Button>
          )}
        </label>
        {showCopies && (
          <>
            <label className="mail-compose-row">
              <span>Копия</span>
              <Input value={cc} onChange={(e) => edit(setCc)(e.target.value)} />
            </label>
            <label className="mail-compose-row">
              <span>Скрытая</span>
              <Input value={bcc} onChange={(e) => edit(setBcc)(e.target.value)} />
            </label>
          </>
        )}
        <label className="mail-compose-row">
          <span>Тема</span>
          <Input value={subject} onChange={(e) => edit(setSubject)(e.target.value)} maxLength={998} />
        </label>
        <Textarea
          value={body}
          onChange={(e) => edit(setBody)(e.target.value)}
          rows={12}
          placeholder="Текст письма"
          autoFocus={draft.mode === 'REPLY' || draft.mode === 'REPLY_ALL'}
          style={{ resize: 'vertical', minHeight: 200 }}
        />
        {draft.attachments.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {draft.attachments.map((a) => (
              <FileChip key={a.id} name={a.fileName} size={formatSize(a.sizeBytes)} onRemove={busy ? undefined : () => void updateAttachments(draft.attachments.filter((x) => x.id !== a.id)).catch(() => undefined)} />
            ))}
          </div>
        )}
        {draft.quote && (
          <details className="mail-quote">
            <summary>{draft.mode === 'FORWARD' ? 'Пересылаемое письмо' : 'Исходное письмо'} будет приложено ниже</summary>
            {draft.quote.map((h) => (
              <div key={h.label}>
                <b>{h.label}:</b> {h.value}
              </div>
            ))}
          </details>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button variant="primary" icon={Send} onClick={send} disabled={busy} loading={busy && saveState !== 'saving'}>
            Отправить
          </Button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
          <IconButton icon={Paperclip} label="Прикрепить файл" variant="outline" onClick={() => fileInput.current?.click()} disabled={busy} />
          <span style={{ flex: 1 }} />
          <IconButton icon={Trash2} label="Удалить черновик" onClick={discard} disabled={busy} />
        </div>
      </div>
    </Card>
  );
}

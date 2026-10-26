'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mail, Send } from 'lucide-react';
import type {
  MailActionGroupType,
  MailActionItemStatus,
  MailActionPlan,
  MailActionPlanContext,
  MailActionPlanItems,
  MailDraftCardData,
  MailDraftView,
  MailPlanCardData,
  MailSendResult,
} from '@ai-task-system/shared-types';
import { MAIL_ACTION_ERROR_LABELS, MAIL_ACTION_TYPE_LABELS } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Alert, Badge, Button, Card, Textarea, type BadgeTone } from '@/components/ui';

// Почта, этап 3 (владелец 23.10.2026) — карточки ассистента в чате. Ассистент
// только предлагает: действия с письмами выполняются после «Подтвердить»
// (тот же план и движок согласования, что вкладка «Планы действий» на /mail), письмо
// уходит после «Отправить». Состояние читается живьём — карточка в истории
// показывает, что с планом/письмом стало на самом деле.
// Копия — apps/miniapp/src/components/assistant-mail-cards.tsx (отличается только api.get).

const POLL_MS = 3_000;
const getWith = <T,>(path: string, headers?: HeadersInit) => api.get<T>(path, undefined, headers);

const ITEM_STATUS: Partial<Record<MailActionItemStatus, [BadgeTone, string]>> = {
  APPROVED: ['info', 'Согласовано'],
  QUEUED: ['info', 'В очереди'],
  RUNNING: ['warn', 'Выполняется'],
  SUCCEEDED: ['ok', 'Выполнено'],
  FAILED: ['danger', 'Ошибка'],
  UNKNOWN: ['warn', 'Результат неизвестен'],
  SKIPPED_CHANGED: ['neutral', 'Письмо изменилось'],
  BLOCKED_DEPENDENCY: ['neutral', 'Не выполнено'],
  CANCELLED: ['neutral', 'Остановлено'],
};
const IN_PROGRESS: ReadonlySet<MailActionItemStatus> = new Set(['APPROVED', 'QUEUED', 'RUNNING']);

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function newKey(): string {
  return crypto.randomUUID();
}

export function MailPlanCard({ data }: { data: MailPlanCardData }) {
  const [plan, setPlan] = useState<MailActionPlan | null>(null);
  const [items, setItems] = useState<MailActionPlanItems | null>(null);
  const [context, setContext] = useState<MailActionPlanContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Ключ попытки согласования на группу: повтор после сбоя сети не исполнит дважды.
  const keys = useRef(new Map<MailActionGroupType, string>());

  const load = useCallback(() => {
    Promise.all([
      api.get<MailActionPlan>(`/mail/action-plans/${data.planId}`),
      api.get<MailActionPlanItems>(`/mail/action-plans/${data.planId}/items`),
      api.get<MailActionPlanContext>(`/mail/action-plans/${data.planId}/context`),
    ])
      .then(([p, i, c]) => {
        setPlan(p);
        setItems(i);
        setContext(c);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorText(err, 'Не удалось загрузить предложение')));
  }, [data.planId]);

  useEffect(load, [load]);

  const list = items?.items ?? [];
  const running = list.some((i) => IN_PROGRESS.has(i.status));
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const pending = list.filter((i) => i.selected && i.status === 'NEEDS_REVIEW');
  const order = pending.filter((i) => i.groupType !== 'TRASH');
  const trash = pending.filter((i) => i.groupType === 'TRASH');
  const declined = list.length > 0 && list.every((i) => !i.selected && i.status === 'NEEDS_REVIEW');

  async function approve(group: MailActionGroupType, ids: string[]) {
    if (!plan) return;
    if (group === 'TRASH' && !window.confirm(`Переместить в корзину писем: ${ids.length}?`)) return;
    setBusy(true);
    setError(null);
    const key = keys.current.get(group) ?? newKey();
    keys.current.set(group, key);
    try {
      await api.post(`/mail/action-plans/${plan.id}/approve`, { planVersion: plan.version, groupType: group, itemIds: ids }, { 'Idempotency-Key': key });
      keys.current.delete(group);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) keys.current.delete(group);
      setError(errorText(err, 'Не удалось подтвердить'));
    } finally {
      setBusy(false);
      load();
    }
  }

  async function approveOrder() {
    // «Порядок в почте» — одна группа на сервере; на случай будущих групп кроме корзины — по одной.
    for (const group of [...new Set(order.map((i) => i.groupType))]) {
      await approve(
        group,
        order.filter((i) => i.groupType === group).map((i) => i.id),
      );
    }
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      for (const item of pending) {
        await api.patch(`/mail/action-plans/${data.planId}/items/${item.id}`, { version: item.version, selected: false });
      }
    } catch (err) {
      setError(errorText(err, 'Не удалось отменить'));
    } finally {
      setBusy(false);
      load();
    }
  }

  const messages = context?.messages ?? {};
  const done = list.length > 0 && pending.length === 0 && !running && !declined;
  const failed = list.filter((i) => i.status === 'FAILED' || i.status === 'UNKNOWN' || i.status === 'BLOCKED_DEPENDENCY').length;
  const succeeded = list.filter((i) => i.status === 'SUCCEEDED').length;

  return (
    <Card tone="sunken" className="mail-card">
      <div className="mail-card-head">
        <Mail size={16} strokeWidth={1.75} />
        <strong>{plan?.requestText ?? 'Действия с письмами'}</strong>
        {declined && <Badge tone="neutral">Отменено</Badge>}
        {done && (failed === 0 ? <Badge tone="ok">Выполнено</Badge> : <Badge tone={succeeded > 0 ? 'warn' : 'danger'}>{succeeded > 0 ? 'Выполнено частично' : 'Не выполнено'}</Badge>)}
      </div>
      <p className="ds-field-hint mail-card-sub">{data.mailboxAddress}</p>
      {loadError && <Alert tone="danger">{loadError}</Alert>}
      {list.length > 0 && (
        <ul className="mail-card-items">
          {list.map((item) => {
            const message = item.stableObjectIds[0] ? messages[item.stableObjectIds[0]] : undefined;
            const status = ITEM_STATUS[item.status];
            const params = item.parameters as { folderPath?: string; name?: string } | null;
            const folder = item.type === 'CREATE_FOLDER' ? params?.name : item.type === 'MOVE' || item.type === 'ARCHIVE' ? params?.folderPath : null;
            const errorCode = item.status === 'NEEDS_REVIEW' ? null : item.lastAttempt?.errorCode;
            return (
              <li key={item.id} className={!item.selected ? 'is-off' : undefined}>
                <span className="mail-card-action">
                  {MAIL_ACTION_TYPE_LABELS[item.type]}
                  {folder ? ` «${folder}»` : ''}
                </span>
                <span className="mail-card-subject">
                  {item.type !== 'CREATE_FOLDER' && (message?.subject || '(без темы)')}
                  {message && <span className="ds-field-hint"> — {message.fromName || message.fromAddress}</span>}
                </span>
                {status && <Badge tone={status[0]}>{status[1]}</Badge>}
                {errorCode && <span className="mail-card-error">{MAIL_ACTION_ERROR_LABELS[errorCode] ?? MAIL_ACTION_ERROR_LABELS.EXECUTOR_ERROR}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {pending.length > 0 && (
        <div className="mail-card-actions">
          {order.length > 0 && (
            <Button variant="primary" size="sm" onClick={approveOrder} loading={busy}>
              Подтвердить · {order.length}
            </Button>
          )}
          {trash.length > 0 && (
            <Button
              variant="danger"
              size="sm"
              onClick={() =>
                approve(
                  'TRASH',
                  trash.map((i) => i.id),
                )
              }
              loading={busy}
            >
              В корзину · {trash.length}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={decline} disabled={busy}>
            Не нужно
          </Button>
        </div>
      )}
    </Card>
  );
}

const MODE_LABEL: Record<MailDraftCardData['mode'], string> = { REPLY: 'Ответ', REPLY_ALL: 'Ответ всем', FORWARD: 'Пересылка' };

export function MailDraftCard({ data }: { data: MailDraftCardData }) {
  const headers = { 'X-Mailbox-Id': data.mailboxId };
  const [draft, setDraft] = useState<MailDraftView | null>(null);
  const [gone, setGone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [rejected, setRejected] = useState<string[]>([]);

  const load = useCallback(() => {
    getWith<MailDraftView>(`/mail/drafts/${data.draftId}`, { 'X-Mailbox-Id': data.mailboxId })
      .then((d) => {
        setDraft(d);
        setLoadError(null);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setGone(true);
        else setLoadError(errorText(err, 'Не удалось загрузить письмо'));
      });
  }, [data.draftId, data.mailboxId]);

  useEffect(load, [load]);

  async function save(): Promise<boolean> {
    if (!draft) return false;
    try {
      const res = await api.patch<{ version: number }>(`/mail/drafts/${draft.id}`, { version: draft.version, body }, headers);
      setDraft({ ...draft, body, version: res.version });
      setEditing(false);
      return true;
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
      return false;
    }
  }

  async function send() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (editing && !(await save())) return;
      const result = await api.post<MailSendResult>(`/mail/drafts/${draft.id}/send`, undefined, headers);
      setRejected(result.rejected);
      load();
    } catch (err) {
      setError(errorText(err, 'Не удалось отправить'));
      load();
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!draft || !window.confirm('Удалить этот черновик?')) return;
    setBusy(true);
    try {
      await api.delete(`/mail/drafts/${draft.id}`, headers);
      setGone(true);
    } catch (err) {
      setError(errorText(err, 'Не удалось удалить'));
    } finally {
      setBusy(false);
    }
  }

  const sent = draft?.state === 'SENT';
  const sending = draft?.state === 'SENDING';

  return (
    <Card tone="sunken" className="mail-card">
      <div className="mail-card-head">
        <Send size={16} strokeWidth={1.75} />
        <strong>{MODE_LABEL[data.mode]}: {draft?.subject ?? data.subject}</strong>
        {sent && <Badge tone="ok">Отправлено</Badge>}
        {sending && <Badge tone="warn">Отправляется</Badge>}
        {gone && <Badge tone="neutral">Удалено</Badge>}
      </div>
      {loadError && <Alert tone="danger">{loadError}</Alert>}
      {draft && !gone && (
        <>
          <dl className="mail-card-fields">
            <div>
              <dt>Кому</dt>
              <dd>{draft.to.join(', ') || '—'}</dd>
            </div>
            {draft.cc.length > 0 && (
              <div>
                <dt>Копия</dt>
                <dd>{draft.cc.join(', ')}</dd>
              </div>
            )}
            {draft.attachments.length > 0 && (
              <div>
                <dt>Вложения</dt>
                <dd>{draft.attachments.map((a) => a.fileName).join(', ')}</dd>
              </div>
            )}
          </dl>
          {editing ? (
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} aria-label="Текст письма" />
          ) : (
            <div className="mail-card-body">{draft.body}</div>
          )}
          {draft.quote && <p className="ds-field-hint mail-card-sub">+ цитата исходного письма</p>}
          {draft.lastError && !sent && <Alert tone="danger">{draft.lastError}</Alert>}
          {rejected.length > 0 && <Alert tone="warn">Сервер не принял адреса: {rejected.join(', ')}</Alert>}
          {error && <Alert tone="danger">{error}</Alert>}
          {draft.state === 'DRAFT' && (
            <div className="mail-card-actions">
              <Button variant="primary" size="sm" icon={Send} onClick={send} loading={busy} disabled={draft.to.length === 0}>
                Отправить
              </Button>
              {editing ? (
                <Button variant="ghost" size="sm" onClick={save} disabled={busy}>
                  Сохранить
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setBody(draft.body);
                    setEditing(true);
                  }}
                  disabled={busy}
                >
                  Изменить
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={discard} disabled={busy}>
                Удалить
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

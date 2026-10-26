'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import type { EmployeeSummary, MailTriageActionPlan, MailTriageItem } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Dialog, Input, Select, cx } from '@/components/ui';
import { useAgentContext } from '@/components/agent-panel/agent-context';
import { AttachmentItem } from './message-detail';
import { senderLabel } from './mail-labels';
import { useMailTriage, type MailTriage, type TriageOutcome, type TriageResult } from './use-mail-triage';

// Вкладка «Разбор» (редизайн web W4, docs/WEB_REDESIGN.md §4.5): слева
// очередь писем, которые ждут ответа или действия, справа текущее — суть,
// черновик ответа и действия. После действия — следующее письмо; в конце
// «Почта разобрана». Отправка, задача и архив — только после «Да».

const IMPORTANCE: Record<string, { label: string; tone: string }> = {
  CRITICAL: { label: 'Критично', tone: 'hot' },
  IMPORTANT: { label: 'Важно', tone: 'hot' },
  NORMAL: { label: 'Обычно', tone: 'normal' },
  LOW: { label: 'Не важно', tone: 'low' },
};

const OUTCOME_LABELS: Record<TriageOutcome, { done: string; pending: string; failed: string }> = {
  SENT: { done: 'Отправлено', pending: 'Отправляется', failed: 'Не отправлено' },
  TASK: { done: 'Поручено', pending: 'Ставлю задачу', failed: 'Задача не создана' },
  LATER: { done: 'Позже', pending: 'Позже', failed: 'Позже' },
  ARCHIVED: { done: 'В архиве', pending: 'В архив…', failed: 'Не в архиве' },
};

function resultLabel(r: TriageResult): string {
  return OUTCOME_LABELS[r.outcome][r.state];
}

function age(receivedAt: string | null): string {
  if (!receivedAt) return '';
  const minutes = Math.max(1, Math.round((Date.now() - new Date(receivedAt).getTime()) / 60000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.round(hours / 24);
  const mod10 = days % 10;
  const mod100 = days % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'день' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'дня' : 'дней';
  return `${days} ${word}`;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('.agent-panel, [role="dialog"]')) return true;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

interface Confirm {
  item: MailTriageItem;
  plan: MailTriageActionPlan;
  title: string;
  text: string;
  yes: string;
}

export function TriagePane({ initialMessageId }: { initialMessageId: string | null }) {
  const t = useMailTriage(initialMessageId);
  const { queue, current, results } = t;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [taskFor, setTaskFor] = useState<string | null>(null);

  useAgentContext(current ? { kind: 'mail', id: current.id, label: current.subject || '(без темы)' } : null);

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  function send(item: MailTriageItem) {
    const draft = t.drafts[item.id];
    if (!draft?.draftId || !draft.text.trim() || busy) return;
    void run(async () => {
      const plan = await t.prepare(item, 'SEND_REPLY');
      const to = item.draft?.toAddresses.join(', ') || item.fromAddress;
      setConfirm({ item, plan, title: 'Отправить ответ?', text: `Ответ на «${item.subject || '(без темы)'}» уйдёт: ${to}.`, yes: 'Отправить' });
    }, 'Не удалось подготовить отправку');
  }

  function archive(item: MailTriageItem) {
    if (busy) return;
    void run(async () => {
      const plan = await t.prepare(item, 'ARCHIVE');
      setConfirm({ item, plan, title: 'Переместить в архив?', text: `Письмо «${item.subject || '(без темы)'}» уйдёт из «Входящих» в архив ящика.`, yes: 'В архив' });
    }, 'Не удалось подготовить архив');
  }

  function later(item: MailTriageItem) {
    if (busy) return;
    void run(() => t.snooze(item), 'Не удалось отложить письмо');
  }

  function cancelConfirm() {
    if (confirm) t.cancel(confirm.item, confirm.plan);
    setConfirm(null);
  }

  function approveConfirmed() {
    if (!confirm) return;
    const { item, plan } = confirm;
    setConfirm(null);
    void run(() => t.approve(item, plan), 'Не удалось подтвердить действие');
  }

  // Клавиши: J/K — письма, Ctrl+Enter — отправить (с подтверждением),
  // T — поручить, L — позже, A — архив.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!queue || confirm) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (current && !(e.target instanceof HTMLElement && e.target.closest('.agent-panel'))) {
          e.preventDefault();
          send(current);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'j' || key === 'k') {
        e.preventDefault();
        const idx = queue.findIndex((i) => i.id === t.currentId);
        const next = queue[Math.min(queue.length - 1, Math.max(0, idx + (key === 'j' ? 1 : -1)))];
        if (next) t.setCurrentId(next.id);
        return;
      }
      if (!current || !t.isOpen(current.id)) return;
      if (key === 't') {
        e.preventDefault();
        setTaskFor(current.id);
      } else if (key === 'l') {
        e.preventDefault();
        later(current);
      } else if (key === 'a') {
        e.preventDefault();
        archive(current);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (t.loadError) return <Alert tone="danger">{t.loadError}</Alert>;
  if (!queue) return <p className="ds-field-hint">Загрузка…</p>;
  if (queue.length === 0) {
    return (
      <div className="triage-done">
        <span className="triage-done-mark">
          <Check size={22} strokeWidth={2.4} />
        </span>
        <strong>Писем, которые ждут ответа, нет</strong>
        <span>Здесь появятся письма, где от вас ждут ответа или действия.</span>
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={t.load}>
          Обновить
        </Button>
      </div>
    );
  }

  const position = current ? queue.findIndex((i) => i.id === current.id) + 1 : 0;

  return (
    <div className="triage">
      <div className="triage-queue" role="list" aria-label="Очередь писем">
        {queue.map((item) => {
          const r = results[item.id];
          const handled = r && r.state !== 'failed';
          const importance = item.analysis?.importance ?? 'NORMAL';
          return (
            <button
              key={item.id}
              type="button"
              role="listitem"
              className={cx('triage-row', item.id === t.currentId && 'is-current', handled && 'is-handled')}
              aria-current={item.id === t.currentId || undefined}
              onClick={() => t.setCurrentId(item.id)}
            >
              <span className={`triage-dot is-${IMPORTANCE[importance]?.tone ?? 'normal'}`} aria-hidden="true" />
              <span className="triage-row-text">
                <span className="triage-row-subject">{item.subject || '(без темы)'}</span>
                <span className="triage-row-from">{senderLabel(item)}</span>
              </span>
              <span className={cx('triage-tag', r && `is-${r.state}`)}>{r ? resultLabel(r) : item.tag === 'REPLY' ? 'Ответ' : 'Действие'}</span>
            </button>
          );
        })}
      </div>

      <div className="triage-main">
        {error && <Alert tone="danger">{error}</Alert>}
        {current ? (
          <TriageCard
            key={current.id}
            t={t}
            item={current}
            position={`${position} из ${queue.length}`}
            busy={busy}
            taskOpen={taskFor === current.id}
            onTask={() => setTaskFor(current.id)}
            onTaskClose={() => setTaskFor(null)}
            onTaskSubmit={(task) =>
              run(async () => {
                const plan = await t.prepare(current, 'CREATE_TASK', task);
                // Форма с кнопкой «Поручить» — и есть подтверждение.
                await t.approve(current, plan);
                setTaskFor(null);
              }, 'Не удалось поставить задачу')
            }
            onSend={() => send(current)}
            onLater={() => later(current)}
            onArchive={() => archive(current)}
          />
        ) : (
          <div className="triage-done">
            <span className="triage-done-mark">
              <Check size={22} strokeWidth={2.4} />
            </span>
            <strong>Почта разобрана</strong>
            <span>
              Отправлено {t.stats.SENT} · поручено {t.stats.TASK} · отложено {t.stats.LATER} · в архиве {t.stats.ARCHIVED}
            </span>
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={t.load}>
              Обновить очередь
            </Button>
          </div>
        )}
      </div>

      {confirm && (
        <Dialog
          title={confirm.title}
          onClose={cancelConfirm}
          footer={
            <>
              <Button variant="secondary" onClick={cancelConfirm}>
                Отмена
              </Button>
              <Button variant="primary" autoFocus onClick={approveConfirmed}>
                {confirm.yes}
              </Button>
            </>
          }
        >
          <p style={{ margin: 0 }}>{confirm.text}</p>
        </Dialog>
      )}
    </div>
  );
}

interface CardProps {
  t: MailTriage;
  item: MailTriageItem;
  position: string;
  busy: boolean;
  taskOpen: boolean;
  onTask: () => void;
  onTaskClose: () => void;
  onTaskSubmit: (task: { title: string; assigneeId: string | null; dueDate: string | null }) => Promise<void>;
  onSend: () => void;
  onLater: () => void;
  onArchive: () => void;
}

function TriageCard({ t, item, position, busy, taskOpen, onTask, onTaskClose, onTaskSubmit, onSend, onLater, onArchive }: CardProps) {
  const result = t.results[item.id];
  const draft = t.drafts[item.id];
  const importance = IMPORTANCE[item.analysis?.importance ?? 'NORMAL'] ?? IMPORTANCE.NORMAL;
  const handled = !!result && result.state !== 'failed';
  const canSend = !!draft?.draftId && !!draft.text.trim() && !draft.loading;
  const actionSummary = item.analysis?.actionSummary && item.analysis.actionSummary !== item.analysis.summary ? item.analysis.actionSummary : null;

  return (
    <article className="triage-card" aria-label="Текущее письмо">
      <div className="triage-card-meta">
        <span className={`triage-importance is-${importance.tone}`}>{importance.label}</span>
        <span className="mono triage-card-age">
          {age(item.receivedAt)} · {position}
        </span>
      </div>
      <div>
        <h2 className="triage-card-subject">{item.subject || '(без темы)'}</h2>
        <p className="triage-card-from">
          {item.fromName ? `${item.fromName} · ${item.fromAddress}` : item.fromAddress}
        </p>
      </div>

      {result?.state === 'failed' && <Alert tone="danger">{result.error}</Alert>}
      {handled && <Alert tone="info">{resultLabel(result)}. Можно перейти к следующему письму.</Alert>}

      <div className="triage-gist">
        <span className="section-kicker">Суть</span>
        <p>{item.analysis?.summary || 'Анализ письма не готов.'}</p>
        {actionSummary && <p className="triage-gist-action">Что нужно: {actionSummary}</p>}
        {item.analysis?.deadline && (
          <p className="triage-gist-action">Срок: {new Date(item.analysis.deadline).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Almaty' })}</p>
        )}
        {item.attachments.length > 0 && (
          <div className="triage-attachments">
            {item.attachments.map((a) => (
              <span key={a.id} className="triage-attachment">
                <AttachmentItem attachment={a} />
              </span>
            ))}
          </div>
        )}
        {item.body && (
          <details className="triage-body">
            <summary>Текст письма</summary>
            <p>{item.body}</p>
          </details>
        )}
      </div>

      {!handled && (
        <>
          <label className="triage-draft">
            <span className="triage-draft-head">
              <span className="section-kicker">Черновик ответа</span>
              {draft?.draftId && !draft.loading && (
                <button type="button" className="triage-link" onClick={() => void t.requestDraft(item.id, true)}>
                  Написать заново
                </button>
              )}
            </span>
            {draft?.loading ? (
              <p className="ds-field-hint">Готовлю черновик…</p>
            ) : draft?.draftId ? (
              <textarea className="triage-draft-input" value={draft.text} rows={7} onChange={(e) => t.setDraftText(item.id, e.target.value)} />
            ) : (
              <span className="triage-draft-empty">
                {draft?.error && <span className="ds-field-hint">{draft.error}</span>}
                <Button variant="secondary" size="sm" onClick={() => void t.requestDraft(item.id)}>
                  Подготовить ответ
                </Button>
              </span>
            )}
          </label>

          {taskOpen ? (
            <TaskForm item={item} busy={busy} onCancel={onTaskClose} onSubmit={onTaskSubmit} />
          ) : (
            <div className="triage-actions">
              <Button variant="primary" disabled={busy || !canSend} title={canSend ? 'Ctrl+Enter' : 'Сначала подготовьте ответ'} onClick={onSend}>
                Отправить
              </Button>
              <Button variant="secondary" disabled={busy} title="T" onClick={onTask}>
                Поручить → задача
              </Button>
              <Button variant="secondary" disabled={busy} title="L" onClick={onLater}>
                Позже
              </Button>
              <Button variant="ghost" disabled={busy} title="A" onClick={onArchive}>
                В архив
              </Button>
            </div>
          )}
          <p className="triage-hint">Отправка, задача и архив — через план действий почты, после вашего подтверждения. Клавиши: J / K, Ctrl+Enter, T, L, A.</p>
        </>
      )}
    </article>
  );
}

function TaskForm({
  item,
  busy,
  onCancel,
  onSubmit,
}: {
  item: MailTriageItem;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (task: { title: string; assigneeId: string | null; dueDate: string | null }) => Promise<void>;
}) {
  const [title, setTitle] = useState(() => (item.analysis?.actionSummary || `Ответить: ${item.subject || 'письмо'}`).slice(0, 300));
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState(() => (item.analysis?.deadline ? item.analysis.deadline.slice(0, 10) : ''));
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);

  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => {});
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    // Срок — конец дня по Алматы.
    void onSubmit({ title: title.trim(), assigneeId: assigneeId || null, dueDate: dueDate ? new Date(`${dueDate}T18:00:00+05:00`).toISOString() : null });
  }

  return (
    <form className="triage-task" onSubmit={submit}>
      <span className="section-kicker">Поручить</span>
      <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Название задачи" maxLength={300} />
      <div className="triage-task-row">
        <Select
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          aria-label="Исполнитель"
          options={[{ value: '', label: 'Без исполнителя' }, ...employees.map((emp) => ({ value: emp.id, label: emp.fullName }))]}
        />
        <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Срок" />
      </div>
      <div className="triage-actions">
        <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
          Поручить
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

'use client';

import { useEffect, useState } from 'react';
import type { MailActionItemStatus, MailActionPlanItems, MailDraftView, MailTriageActionPlan, MailTriageActionType, MailTriageItem } from '@ai-task-system/shared-types';
import { MAIL_ACTION_ERROR_LABELS } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';

// Разбор почты (редизайн web W4, docs/WEB_REDESIGN.md §4.5): очередь,
// черновики и действия. Ответ, задача и архив — план из одного пункта в
// движке mail/action, исполняется только после согласия (approve); «Позже»
// ничего в ящике не меняет и идёт напрямую.

export type TriageOutcome = 'SENT' | 'TASK' | 'LATER' | 'ARCHIVED';

export interface TriageResult {
  outcome: TriageOutcome;
  state: 'pending' | 'done' | 'failed';
  planId?: string;
  itemId?: string;
  error?: string;
}

export interface TriageDraft {
  draftId: string | null;
  text: string;
  loading: boolean;
  error: string | null;
}

const OUTCOME_BY_TYPE: Record<MailTriageActionType, TriageOutcome> = { SEND_REPLY: 'SENT', CREATE_TASK: 'TASK', ARCHIVE: 'ARCHIVED' };
const TERMINAL: MailActionItemStatus[] = ['SUCCEEDED', 'FAILED', 'UNKNOWN', 'SKIPPED_CHANGED', 'BLOCKED_DEPENDENCY', 'CANCELLED', 'COMPENSATED'];
const POLL_MS = 2_000;

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function useMailTriage(initialMessageId: string | null) {
  const [queue, setQueue] = useState<MailTriageItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(initialMessageId);
  const [results, setResults] = useState<Record<string, TriageResult>>({});
  const [drafts, setDrafts] = useState<Record<string, TriageDraft>>({});

  function load() {
    api
      .get<MailTriageItem[]>('/mail/triage')
      .then((items) => {
        setLoadError(null);
        setQueue(items);
        setResults({});
        setDrafts(Object.fromEntries(items.filter((i) => i.draft).map((i) => [i.id, { draftId: i.draft!.id, text: i.draft!.body ?? '', loading: false, error: null }])));
        setCurrentId((id) => (id && items.some((i) => i.id === id) ? id : (items[0]?.id ?? null)));
      })
      .catch(() => setLoadError('Не удалось загрузить очередь писем'));
  }

  useEffect(load, []);

  const current = queue?.find((i) => i.id === currentId) ?? null;
  const isOpen = (id: string) => !results[id] || results[id].state === 'failed';

  // Черновик для письма, которое ждёт ответа, — если фон ещё не успел.
  async function requestDraft(id: string, regenerate = false) {
    setDrafts((d) => ({ ...d, [id]: { draftId: d[id]?.draftId ?? null, text: d[id]?.text ?? '', loading: true, error: null } }));
    try {
      const draft = await api.post<MailDraftView>(`/mail/messages/${id}/draft-reply${regenerate ? '?regenerate=true' : ''}`);
      setDrafts((d) => ({ ...d, [id]: { draftId: draft.id, text: draft.body, loading: false, error: null } }));
    } catch (err) {
      setDrafts((d) => ({ ...d, [id]: { ...d[id], loading: false, error: errorText(err, 'Не удалось подготовить черновик') } }));
    }
  }

  useEffect(() => {
    if (current && current.tag === 'REPLY' && !drafts[current.id] && isOpen(current.id)) void requestDraft(current.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  function setDraftText(id: string, text: string) {
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? { draftId: null, loading: false, error: null }), text } }));
  }

  // Следующее необработанное после текущего (по кругу); нет — конец разбора.
  function advance(fromId: string, nextResults: Record<string, TriageResult>) {
    if (!queue) return;
    const open = (id: string) => !nextResults[id] || nextResults[id].state === 'failed';
    const idx = queue.findIndex((i) => i.id === fromId);
    for (let k = 1; k <= queue.length; k++) {
      const item = queue[(idx + k) % queue.length];
      if (open(item.id) && item.id !== fromId) return setCurrentId(item.id);
    }
    setCurrentId(null);
  }

  function record(id: string, result: TriageResult) {
    const next = { ...results, [id]: result };
    setResults(next);
    advance(id, next);
  }

  // Шаг 1 — план из одного пункта (для окна подтверждения).
  async function prepare(item: MailTriageItem, type: MailTriageActionType, task?: { title: string; assigneeId: string | null; dueDate: string | null }): Promise<MailTriageActionPlan> {
    const draft = drafts[item.id];
    const body =
      type === 'SEND_REPLY'
        ? { type, draftId: draft?.draftId ?? undefined, draftText: draft?.text }
        : type === 'CREATE_TASK'
          ? { type, task }
          : { type };
    return api.post<MailTriageActionPlan>(`/mail/messages/${item.id}/actions`, body, { 'Idempotency-Key': crypto.randomUUID() });
  }

  // Шаг 2 — «Да»: согласие существующим approve, исполнение — в фоне.
  async function approve(item: MailTriageItem, plan: MailTriageActionPlan) {
    await api.post(`/mail/action-plans/${plan.planId}/approve`, { planVersion: plan.planVersion, groupType: plan.groupType, itemIds: [plan.itemId] }, { 'Idempotency-Key': crypto.randomUUID() });
    record(item.id, { outcome: OUTCOME_BY_TYPE[plan.type], state: 'pending', planId: plan.planId, itemId: plan.itemId });
  }

  // «Отмена» в окне подтверждения — несогласованный план не должен висеть
  // в «Планах действий».
  function cancel(item: MailTriageItem, plan: MailTriageActionPlan) {
    api.post(`/mail/messages/${item.id}/actions/${plan.planId}/cancel`).catch(() => {});
  }

  async function snooze(item: MailTriageItem) {
    await api.post(`/mail/messages/${item.id}/snooze`);
    record(item.id, { outcome: 'LATER', state: 'done' });
  }

  // Исполнение согласованных пунктов — опрос до конечного статуса.
  const pending = Object.entries(results).filter(([, r]) => r.state === 'pending');
  const pendingKey = pending.map(([id]) => id).join(',');
  useEffect(() => {
    if (!pendingKey) return;
    const timer = setInterval(() => {
      for (const [id, r] of Object.entries(results)) {
        if (r.state !== 'pending' || !r.planId) continue;
        api
          .get<MailActionPlanItems>(`/mail/action-plans/${r.planId}/items`)
          .then(({ items }) => {
            const item = items.find((i) => i.id === r.itemId);
            if (!item || !TERMINAL.includes(item.status)) return;
            const code = item.lastAttempt?.errorCode;
            setResults((prev) => ({
              ...prev,
              [id]:
                item.status === 'SUCCEEDED'
                  ? { ...r, state: 'done' }
                  : { ...r, state: 'failed', error: (code && MAIL_ACTION_ERROR_LABELS[code]) || 'Не выполнено — откройте «Планы действий»' },
            }));
          })
          .catch(() => {});
      }
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const stats = { SENT: 0, TASK: 0, LATER: 0, ARCHIVED: 0 } as Record<TriageOutcome, number>;
  for (const r of Object.values(results)) if (r.state !== 'failed') stats[r.outcome]++;

  return { queue, loadError, load, current, currentId, setCurrentId, results, drafts, requestDraft, setDraftText, prepare, approve, cancel, snooze, stats, isOpen };
}

export type MailTriage = ReturnType<typeof useMailTriage>;

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import type {
  ApproveMeetingProposalResult,
  EmployeeSummary,
  MeetingProposal,
  MeetingProposalsResponse,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { Panel, StatusTag } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Chip } from '@/components/ui/chip';
import { Input, Select } from '@/components/ui/field';
import { ConfidenceMeter } from '@/components/ui/agent-suggestion';

// Поручения из встречи (AGENT_AND_MEETINGS.md, B.5). Разбор запускает
// только руководитель кнопкой — не все записи требуют задач (владелец
// 01.11.2026). Ничего не создаётся, пока он не нажмёт «Утвердить».

const POLL_MS = 3000;

interface RowEdit {
  selected: boolean;
  title: string;
  assigneeId: string;
  // «ГГГГ-ММ-ДД» по местному времени или пусто.
  due: string;
}

// Срок для поля даты — день по Алматы, не по часовому поясу браузера.
function localDay(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Almaty' }) : '';
}

// По умолчанию выбраны все, кроме похожих на уже существующие задачи и
// неуверенных — их руководитель включает сам.
function defaultEdit(p: MeetingProposal): RowEdit {
  return {
    selected: !p.similarTask && p.confidence !== 'LOW',
    title: p.title,
    assigneeId: p.assignee?.id ?? '',
    due: localDay(p.dueDate),
  };
}

function pluralProposals(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'поручение';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'поручения';
  return 'поручений';
}

export function MeetingProposalsPanel({
  meetingId,
  onMeetingChanged,
}: {
  meetingId: string;
  // Созданы задачи или разбор применил имена говорящих — встречу перечитать.
  onMeetingChanged: () => void;
}) {
  const [data, setData] = useState<MeetingProposalsResponse | null>(null);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [busy, setBusy] = useState<'start' | 'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const startKey = useIdempotencyKey();
  const approveKey = useIdempotencyKey();
  const rejectKey = useIdempotencyKey();

  const load = useCallback(() => {
    api
      .get<MeetingProposalsResponse>(`/meetings/${meetingId}/proposals`)
      .then(setData)
      .catch(() => setError('Не удалось загрузить поручения'));
  }, [meetingId]);

  useEffect(() => {
    load();
    api
      .get<EmployeeSummary[]>('/employees')
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, [load]);

  const running = data?.run?.status === 'QUEUED' || data?.run?.status === 'RUNNING';

  // Пока разбор идёт — опрос; когда закончился — перечитать встречу: шаг
  // «говорящие» мог применить имена и пересчитать саммари.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onMeetingChanged();
    wasRunning.current = running;
    if (!running) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load, onMeetingChanged]);

  // Ключ повтора сбрасывается после ответа сервера (успех или 4xx); после
  // сбоя сети или 5xx остаётся — повтор того же действия не задвоит его.
  function settle<T>(key: { reset: () => void }, promise: Promise<T>): Promise<T> {
    return promise.then(
      (v) => {
        key.reset();
        return v;
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status < 500) key.reset();
        throw err;
      },
    );
  }

  async function start() {
    if (data?.run?.status === 'DONE' && !data.run.inputChanged && !window.confirm('Запись не менялась с прошлого разбора. Разобрать ещё раз?')) return;
    setBusy('start');
    setError(null);
    try {
      await settle(startKey, api.post(`/meetings/${meetingId}/analysis`, undefined, { 'Idempotency-Key': startKey.key() }));
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось запустить разбор');
    } finally {
      setBusy(null);
    }
  }

  const proposals = data?.proposals ?? [];
  const pending = proposals.filter((p) => p.status === 'PROPOSED');
  const approvedCount = proposals.filter((p) => p.status === 'APPROVED').length;
  const editOf = (p: MeetingProposal) => edits[`${p.id}:${p.version}`] ?? defaultEdit(p);
  const selected = pending.filter((p) => editOf(p).selected);
  const unselected = pending.filter((p) => !editOf(p).selected);

  function update(p: MeetingProposal, patch: Partial<RowEdit>) {
    setEdits((prev) => ({ ...prev, [`${p.id}:${p.version}`]: { ...editOf(p), ...patch } }));
  }

  async function approve() {
    if (selected.length === 0) return;
    setBusy('approve');
    setError(null);
    setItemErrors({});
    // Только то, что руководитель поменял, — остальное сервер берёт из
    // предложения.
    const items = selected.map((p) => {
      const e = editOf(p);
      const base = defaultEdit(p);
      return {
        id: p.id,
        version: p.version,
        ...(e.title.trim() !== p.title ? { title: e.title.trim() } : {}),
        ...(e.assigneeId !== base.assigneeId ? { assigneeId: e.assigneeId || null } : {}),
        ...(e.due !== base.due ? { dueDate: e.due || null } : {}),
      };
    });
    try {
      const { results } = await settle(
        approveKey,
        api.post<{ results: ApproveMeetingProposalResult[] }>(`/meetings/${meetingId}/proposals/approve`, { items }, { 'Idempotency-Key': approveKey.key() }),
      );
      const failed: Record<string, string> = {};
      for (const r of results) if ('error' in r) failed[r.id] = r.message;
      setItemErrors(failed);
      load();
      onMeetingChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось утвердить поручения');
    } finally {
      setBusy(null);
    }
  }

  async function rejectRest() {
    if (unselected.length === 0) return;
    setBusy('reject');
    setError(null);
    try {
      await settle(
        rejectKey,
        api.post(`/meetings/${meetingId}/proposals/reject`, { ids: unselected.map((p) => p.id) }, { 'Idempotency-Key': rejectKey.key() }),
      );
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось отклонить поручения');
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <Panel icon={ClipboardCheck} title="Поручения">
        {error ? <Alert tone="danger">{error}</Alert> : <p className="panel-hint">Загрузка…</p>}
      </Panel>
    );
  }

  const run = data.run;
  const noTranscriptHint = !data.hasTranscript && (
    <p className="panel-hint">Расшифровки ещё нет — поручения будут без ссылок на реплики.</p>
  );

  return (
    <Panel
      icon={ClipboardCheck}
      title="Поручения"
      aside={pending.length > 0 && <StatusTag tone="muted">{`ждут решения: ${pending.length}`}</StatusTag>}
    >
      {!run && (
        <>
          <p className="panel-hint">Найду в записи поручения с исполнителями и сроками. Задачи появятся только после вашего утверждения.</p>
          {noTranscriptHint}
          <div className="panel-actions">
            <Button variant="primary" onClick={start} disabled={busy !== null} loading={busy === 'start'}>
              Найти поручения
            </Button>
          </div>
        </>
      )}

      {running && <p className="panel-hint">Разбираю запись… Обычно это занимает пару минут.</p>}

      {run?.status === 'FAILED' && (
        <>
          <Alert tone="danger">{run.error ?? 'Не удалось разобрать запись'}</Alert>
          <div className="panel-actions">
            <Button variant="secondary" size="sm" onClick={start} disabled={busy !== null} loading={busy === 'start'}>
              Повторить
            </Button>
          </div>
        </>
      )}

      {run && !running && run.status === 'DONE' && pending.length === 0 && (
        <p className="panel-hint">
          {approvedCount > 0
            ? `Утверждено: ${approvedCount} ${pluralProposals(approvedCount)} — задачи ниже.`
            : 'Явных поручений в записи не нашлось.'}
        </p>
      )}

      {pending.length > 0 && (
        <ul className="row-list proposal-list">
          {pending.map((p) => {
            const e = editOf(p);
            return (
              <li key={p.id} className="row-item proposal-row">
                <input
                  type="checkbox"
                  aria-label={`Утвердить: ${p.title}`}
                  checked={e.selected}
                  onChange={(ev) => update(p, { selected: ev.target.checked })}
                />
                <div className="row-item-main">
                  <Input value={e.title} onChange={(ev) => update(p, { title: ev.target.value })} aria-label="Название" />
                  <div className="proposal-fields">
                    <Select
                      aria-label="Исполнитель"
                      value={e.assigneeId}
                      onChange={(ev) => update(p, { assigneeId: ev.target.value })}
                      options={[{ value: '', label: 'Без исполнителя' }, ...employees.map((emp) => ({ value: emp.id, label: emp.fullName }))]}
                    />
                    <Input type="date" aria-label="Срок" value={e.due} onChange={(ev) => update(p, { due: ev.target.value })} />
                  </div>
                  {!e.assigneeId && p.assigneeRawText && <p className="row-item-meta">{`В записи: «${p.assigneeRawText}»`}</p>}
                  <p className="row-item-meta">
                    {p.sourceTimestamp && <Chip>{p.sourceTimestamp}</Chip>} {p.sourceContext}
                  </p>
                  {p.similarTask && (
                    <p className="row-item-meta">
                      Похоже на <Link href={`/tasks/${p.similarTask.id}`}>{`«${p.similarTask.title}»`}</Link>
                    </p>
                  )}
                  {itemErrors[p.id] && <Alert tone="danger">{itemErrors[p.id]}</Alert>}
                </div>
                <span className="row-item-side">
                  <ConfidenceMeter level={p.confidence} />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {run && !running && (
        <div className="panel-actions">
          {pending.length > 0 && (
            <Button variant="primary" onClick={approve} disabled={busy !== null || selected.length === 0} loading={busy === 'approve'}>
              {`Утвердить выбранные · ${selected.length}`}
            </Button>
          )}
          {unselected.length > 0 && (
            <Button variant="secondary" onClick={rejectRest} disabled={busy !== null} loading={busy === 'reject'}>
              Отклонить остальные
            </Button>
          )}
          {run.status === 'DONE' && (
            <Button variant="ghost" size="sm" onClick={start} disabled={busy !== null} loading={busy === 'start'}>
              Разобрать заново
            </Button>
          )}
        </div>
      )}
      {run?.status === 'DONE' && !running && noTranscriptHint}
    </Panel>
  );
}

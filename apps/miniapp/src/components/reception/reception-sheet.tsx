'use client';

import { useEffect, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import type {
  AnswerReceptionRequestInput,
  EmployeeSummary,
  ReceptionAnswerTemplate,
  ReceptionRequestItem,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { addDays, companyDayKey, companyDayStart } from '@/lib/company-time';
import { notificationHaptic, useMainButton } from '@/lib/telegram';
import { useDictation } from '@/lib/use-dictation';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { Alert, Button, Checkbox, Dialog, IconButton, Input, Select, Textarea } from '@/components/ui';
import { OverlayPortal } from '../overlay-portal';
import { ReceptionAttachmentList } from '../reception-attachments';
import { isQueueChanged } from './reception-actions';

// Нижний лист приёмной руководителя (редизайн M4, MINIAPP_REDESIGN.md §4.5):
// «Ответить» (текст, шаблоны, диктовка, «поставить задачу»), «Разберитесь
// сами» (необязательный комментарий) и «Завершить приём» (итог). Все — с
// version и Idempotency-Key; изменилась очередь — onConflict, экран
// покажет тост и перезагрузит доску.

export type SheetMode = 'answer' | 'delegate' | 'complete';

const TITLES: Record<SheetMode, string> = {
  answer: 'Ответить',
  delegate: 'Разберитесь сами',
  complete: 'Завершить приём',
};
const PLACEHOLDERS: Record<SheetMode, string> = {
  answer: 'Ответ сотруднику — напишите или надиктуйте',
  delegate: 'Комментарий — необязательно',
  complete: 'Итог обсуждения — необязательно',
};
const SUBMIT: Record<SheetMode, string> = {
  answer: 'Отправить ответ',
  delegate: 'Передать',
  complete: 'Завершить приём',
};
const PATHS: Record<SheetMode, string> = { answer: 'answer', delegate: 'delegate', complete: 'complete' };

// Срок задачи — 18:00 выбранного дня по времени компании (как в web).
function dueAt(key: string): string {
  return new Date(companyDayStart(key).getTime() + 18 * 3_600_000).toISOString();
}

export function ReceptionSheet({
  item,
  mode,
  onClose,
  onDone,
  onConflict,
}: {
  item: ReceptionRequestItem;
  mode: SheetMode;
  onClose: () => void;
  onDone: (message: string) => void;
  onConflict: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ReceptionAnswerTemplate[]>([]);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  // «Поставить задачу» вместе с ответом: по умолчанию — автору вопроса.
  const [task, setTask] = useState<{ title: string; assigneeId: string; dueDate: string } | null>(null);
  const idem = useIdempotencyKey();
  const [dictationFields] = useState(() => ({ requestId: item.id }));
  const dictation = useDictation(
    '/reception/transcribe',
    (spoken) => setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${spoken}` : spoken)),
    dictationFields,
  );

  useEffect(() => {
    if (mode !== 'answer') return;
    api.get<ReceptionAnswerTemplate[]>('/reception/templates').then(setTemplates).catch(() => undefined);
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => undefined);
  }, [mode]);

  const trimmed = text.trim();
  const recording = dictation.phase === 'recording';
  const processing = dictation.phase === 'processing';
  const locked = busy || recording || processing;
  const ready = mode !== 'answer' || (trimmed.length > 0 && (!task || task.title.trim().length > 0));

  async function submit() {
    setBusy(true);
    setError(null);
    const body =
      mode === 'answer'
        ? ({
            version: item.version,
            text: trimmed,
            task: task ? { title: task.title.trim(), assigneeId: task.assigneeId, dueDate: task.dueDate ? dueAt(task.dueDate) : undefined } : undefined,
          } satisfies AnswerReceptionRequestInput)
        : mode === 'delegate'
          ? { version: item.version, comment: trimmed || undefined }
          : { version: item.version, resolution: trimmed || undefined };
    try {
      await api.post(`/reception/requests/${item.id}/${PATHS[mode]}`, body, { 'Idempotency-Key': idem.key() });
      idem.reset();
      notificationHaptic('success');
      onDone(mode === 'answer' ? (task ? 'Ответ отправлен, задача поставлена' : 'Ответ отправлен') : mode === 'delegate' ? 'Передано' : 'Приём завершён');
    } catch (err) {
      idem.reset();
      notificationHaptic('error');
      if (isQueueChanged(err)) {
        onConflict();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Не удалось выполнить действие');
      setBusy(false);
    }
  }

  const nativeMain = useMainButton({ text: SUBMIT[mode], onClick: () => void submit(), disabled: locked || !ready, loading: busy });

  const assignees = employees.some((e) => e.id === item.author.id) ? employees : [{ id: item.author.id, fullName: item.author.fullName } as EmployeeSummary, ...employees];

  return (
    <OverlayPortal>
      <Dialog
        sheet
        title={TITLES[mode]}
        description={`${item.author.fullName} · ${item.title}`}
        onClose={onClose}
        footer={
          !nativeMain && (
          <Button variant="primary" block onClick={() => void submit()} disabled={locked || !ready} loading={busy}>
            {SUBMIT[mode]}
          </Button>
          )
        }
      >
        <div className="rcp-sheet">
          {mode !== 'complete' && item.description && <p className="rcp-sheet-question">{item.description}</p>}
          {mode !== 'complete' && item.attachments.length > 0 && <ReceptionAttachmentList requestId={item.id} attachments={item.attachments} />}

          <div className="rcp-sheet-input">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={processing ? 'Распознаю и оформляю ответ…' : PLACEHOLDERS[mode]}
              maxLength={mode === 'delegate' ? 1000 : 3000}
              rows={4}
              disabled={processing}
              hidden={recording}
            />
            {recording && (
              <p className={dictation.liveText ? 'live-transcript' : 'live-transcript is-empty'} aria-live="polite">
                {dictation.liveText || `Говорите… ${Math.floor(dictation.elapsedSec / 60)}:${String(dictation.elapsedSec % 60).padStart(2, '0')}`}
              </p>
            )}
            {mode === 'answer' && (
              <IconButton
                icon={recording ? Square : Mic}
                label={recording ? 'Остановить запись' : 'Надиктовать'}
                variant={recording ? 'primary' : 'outline'}
                className="rcp-sheet-mic"
                onClick={recording ? dictation.stop : () => void dictation.start()}
                disabled={busy || processing}
              />
            )}
          </div>
          {dictation.error && <Alert tone="danger">{dictation.error}</Alert>}

          {mode === 'answer' && templates.length > 0 && (
            <div className="filter-chips" aria-label="Шаблоны ответа">
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="filter-chip rcp-template"
                  disabled={locked}
                  onClick={() => setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${t.text}` : t.text))}
                >
                  {t.text}
                </button>
              ))}
            </div>
          )}

          {mode === 'answer' && (
            <>
              <Checkbox
                label="Поставить задачу"
                checked={task !== null}
                disabled={locked}
                onChange={(e) => setTask(e.target.checked ? { title: item.title, assigneeId: item.author.id, dueDate: '' } : null)}
              />
              {task && (
                <div className="rcp-task">
                  <Input value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} placeholder="Что сделать" maxLength={300} aria-label="Задача" />
                  <Select
                    value={task.assigneeId}
                    onChange={(e) => setTask({ ...task, assigneeId: e.target.value })}
                    aria-label="Исполнитель"
                    options={assignees.map((e) => ({ value: e.id, label: e.id === item.author.id ? `${e.fullName} — автор вопроса` : e.fullName }))}
                  />
                  <Input
                    type="date"
                    value={task.dueDate}
                    min={companyDayKey(new Date())}
                    max={addDays(companyDayKey(new Date()), 365)}
                    onChange={(e) => setTask({ ...task, dueDate: e.target.value })}
                    aria-label="Срок"
                  />
                </div>
              )}
            </>
          )}

          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </Dialog>
    </OverlayPortal>
  );
}

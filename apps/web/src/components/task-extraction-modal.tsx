'use client';

import { useEffect, useState } from 'react';
import { Inbox } from 'lucide-react';
import type {
  CreateTaskInput,
  EmployeeSummary,
  ExtractMeetingTasksResponse,
  MeetingTaskDraft,
  TaskPriority,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { PRIORITY_LABELS } from '@/lib/labels';
import { Dialog, Field, Input, Textarea, Select, Alert, EmptyState, AgentSuggestion, Button } from '@/components/ui';

type DraftState = 'pending' | 'accepted' | 'rejected';

interface DraftRow extends MeetingTaskDraft {
  key: string;
  state: DraftState;
  editing: boolean;
}

// Владелец 09.09.2026: осознанное действие, не автомат — руководитель
// видит предложения ассистента и явно принимает («Создать») или пропускает
// каждое, затем подтверждает итог одной кнопкой. Ничего не создаётся до
// этого подтверждения. Дизайн-система «Адъютант» (владелец 04.10.2026,
// implementation.md шаг 9) — AgentSuggestion/ConfidenceMeter вместо
// старой всегда-редактируемой формы на каждую строку.
export function TaskExtractionModal({
  meetingId,
  onClose,
  onCreated,
}: {
  meetingId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      api.post<ExtractMeetingTasksResponse>(`/meetings/${meetingId}/extract-tasks`),
      api.get<EmployeeSummary[]>('/employees'),
    ])
      .then(([res, emps]) => {
        setDrafts(res.drafts.map((d, i) => ({ ...d, key: `${i}-${d.title}`, state: 'pending' as const, editing: false })));
        setEmployees(emps);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось разобрать саммари'))
      .finally(() => setLoading(false));
  }, [meetingId]);

  function updateDraft(key: string, patch: Partial<DraftRow>) {
    setDrafts((prev) => prev?.map((d) => (d.key === key ? { ...d, ...patch } : d)) ?? null);
  }

  const acceptedCount = drafts?.filter((d) => d.state === 'accepted').length ?? 0;

  async function handleSubmit() {
    if (!drafts || acceptedCount === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const tasks: CreateTaskInput[] = drafts
        .filter((d) => d.state === 'accepted')
        .map((d) => ({
          title: d.title,
          description: d.description || undefined,
          assigneeId: d.assigneeId || undefined,
          priority: d.priority || undefined,
          dueDate: d.dueDate || undefined,
          sourceContext: d.sourceContext || undefined,
          aiConfidence: d.confidence,
        }));
      await api.post(`/meetings/${meetingId}/tasks`, { tasks });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать задачи');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title="Задачи из саммари"
      onClose={onClose}
      footer={
        drafts && drafts.length > 0 ? (
          <Button variant="primary" onClick={handleSubmit} disabled={submitting || acceptedCount === 0} loading={submitting}>
            {`Создать ${acceptedCount} ${pluralTasks(acceptedCount)}`}
          </Button>
        ) : undefined
      }
    >
      {loading && <p className="ds-field-hint">Анализируем саммари…</p>}
      {error && <Alert tone="danger">{error}</Alert>}

      {!loading && drafts && drafts.length === 0 && !error && (
        <EmptyState icon={Inbox} title="AI не нашёл явных задач в этом саммари" />
      )}

      {!loading &&
        drafts?.map((d) =>
          d.editing ? (
            <div key={d.key} className="ds-suggest">
              <Field label="Название">
                <Input value={d.title} onChange={(e) => updateDraft(d.key, { title: e.target.value })} />
              </Field>
              <Field label="Описание">
                <Textarea
                  rows={2}
                  value={d.description ?? ''}
                  onChange={(e) => updateDraft(d.key, { description: e.target.value || null })}
                />
              </Field>
              <div style={{ display: 'flex', gap: 12 }}>
                <Field label="Исполнитель">
                  <Select
                    value={d.assigneeId ?? ''}
                    onChange={(e) => updateDraft(d.key, { assigneeId: e.target.value || null, assigneeName: employees.find((emp) => emp.id === e.target.value)?.fullName ?? null })}
                    options={[{ value: '', label: 'Не назначен' }, ...employees.map((emp) => ({ value: emp.id, label: emp.fullName }))]}
                  />
                </Field>
                <Field label="Приоритет">
                  <Select
                    value={d.priority ?? ''}
                    onChange={(e) => updateDraft(d.key, { priority: (e.target.value || null) as TaskPriority | null })}
                    options={[{ value: '', label: 'Не указан' }, ...(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))]}
                  />
                </Field>
                <Field label="Срок">
                  <Input
                    type="date"
                    value={d.dueDate ? d.dueDate.slice(0, 10) : ''}
                    onChange={(e) => updateDraft(d.key, { dueDate: e.target.value || null })}
                  />
                </Field>
              </div>
              <Button size="sm" variant="secondary" onClick={() => updateDraft(d.key, { editing: false })} style={{ alignSelf: 'flex-start' }}>
                Готово
              </Button>
            </div>
          ) : (
            <AgentSuggestion
              key={d.key}
              title={d.title}
              quote={d.sourceContext}
              confidence={d.confidence}
              assignee={d.assigneeName}
              due={d.dueDate ? d.dueDate.slice(0, 10) : null}
              state={d.state === 'pending' ? null : d.state}
              onAccept={() => updateDraft(d.key, { state: 'accepted' })}
              onReject={() => updateDraft(d.key, { state: d.state === 'rejected' ? 'pending' : 'rejected' })}
              onEdit={() => updateDraft(d.key, { editing: true })}
            />
          ),
        )}
    </Dialog>
  );
}

function pluralTasks(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'задачу';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'задачи';
  return 'задач';
}

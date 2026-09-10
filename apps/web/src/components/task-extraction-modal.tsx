'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type {
  CreateTaskInput,
  EmployeeSummary,
  ExtractMeetingTasksResponse,
  MeetingTaskDraft,
  TaskPriority,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { PRIORITY_LABELS, CONFIDENCE_LABELS } from '@/lib/labels';

interface DraftRow extends MeetingTaskDraft {
  key: string;
}

// Владелец 09.09.2026: осознанное действие, не автомат — руководитель
// видит черновики, редактирует/убирает лишние и только тогда подтверждает.
// Ничего не создаётся до нажатия «Создать N задач». Первый модальный UI на
// web (см. комментарий у .modal-backdrop в globals.css).
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
        setDrafts(res.drafts.map((d, i) => ({ ...d, key: `${i}-${d.title}` })));
        setEmployees(emps);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось разобрать саммари'))
      .finally(() => setLoading(false));
  }, [meetingId]);

  function updateDraft(key: string, patch: Partial<DraftRow>) {
    setDrafts((prev) => prev?.map((d) => (d.key === key ? { ...d, ...patch } : d)) ?? null);
  }

  function removeDraft(key: string) {
    setDrafts((prev) => prev?.filter((d) => d.key !== key) ?? null);
  }

  async function handleSubmit() {
    if (!drafts || drafts.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const tasks: CreateTaskInput[] = drafts.map((d) => ({
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>Задачи из саммари</h2>
          <button className="btn-secondary btn-small" onClick={onClose} aria-label="Закрыть">
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        {loading && <p className="hint">Анализируем саммари…</p>}
        {error && <p className="error">{error}</p>}

        {!loading && drafts && drafts.length === 0 && !error && (
          <p className="hint">AI не нашёл явных задач в этом саммари.</p>
        )}

        {!loading &&
          drafts?.map((d) => (
            <div key={d.key} className="draft-task-row">
              <button
                className="btn-secondary btn-small"
                onClick={() => removeDraft(d.key)}
                aria-label="Убрать"
                style={{ position: 'absolute', top: 10, right: 10 }}
              >
                <X size={13} strokeWidth={2} />
              </button>

              <label>
                Название
                <input value={d.title} onChange={(e) => updateDraft(d.key, { title: e.target.value })} />
              </label>
              <label>
                Описание
                <textarea
                  rows={2}
                  value={d.description ?? ''}
                  onChange={(e) => updateDraft(d.key, { description: e.target.value || null })}
                />
              </label>
              <div style={{ display: 'flex', gap: 12 }}>
                <label style={{ flex: 1 }}>
                  Исполнитель
                  <select
                    value={d.assigneeId ?? ''}
                    onChange={(e) => updateDraft(d.key, { assigneeId: e.target.value || null })}
                  >
                    <option value="">Не назначен</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.fullName}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  Приоритет
                  <select
                    value={d.priority ?? ''}
                    onChange={(e) => updateDraft(d.key, { priority: (e.target.value || null) as TaskPriority | null })}
                  >
                    <option value="">Не указан</option>
                    {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABELS[p]}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  Срок
                  <input
                    type="date"
                    value={d.dueDate ? d.dueDate.slice(0, 10) : ''}
                    onChange={(e) => updateDraft(d.key, { dueDate: e.target.value || null })}
                  />
                </label>
              </div>
              <span className="badge badge-muted">{CONFIDENCE_LABELS[d.confidence]}</span>
              <p className="draft-task-source">«{d.sourceContext}»</p>
            </div>
          ))}

        {!loading && drafts && drafts.length > 0 && (
          <button onClick={handleSubmit} disabled={submitting} style={{ marginTop: 4 }}>
            {submitting ? 'Создаём…' : `Создать ${drafts.length} ${pluralTasks(drafts.length)}`}
          </button>
        )}
      </div>
    </div>
  );
}

function pluralTasks(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'задачу';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'задачи';
  return 'задач';
}

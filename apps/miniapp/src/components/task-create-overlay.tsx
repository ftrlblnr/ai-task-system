'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { CreateTaskInput, EmployeeSummary, TaskDetail, TaskPriority } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { OverlayPortal } from './overlay-portal';
import { PRIORITY_LABELS } from '@/lib/labels';
import { haptic } from '@/lib/telegram';
import { Field, Input, Textarea, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

// Раздел 5 ТЗ (скорректировано 28.08.2026): задачу друг другу — включая
// руководителю — может поставить любой участник, не только OWNER, поэтому
// экран доступен всем. Источник (встреча Plaud) сюда сознательно не
// вынесен — импорт из Plaud внутри Mini App ещё не построен (см. README).
export function TaskCreateOverlay({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [dueDate, setDueDate] = useState('');

  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => {});
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload: CreateTaskInput = {
        title,
        description: description || undefined,
        assigneeId: assigneeId || undefined,
        priority,
        dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
      };
      await api.post<TaskDetail>('/tasks', payload);
      haptic('medium');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать задачу');
      setSubmitting(false);
    }
  }

  return (
    <OverlayPortal>
    <div className="overlay">
      <div className="overlay-header">
        <button className="back-btn" onClick={onClose} aria-label="Назад">
          <ArrowLeft size={17} strokeWidth={2.25} />
        </button>
        <strong>Новая задача</strong>
      </div>
      <div className="overlay-body">
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Название">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </Field>

          <Field label="Описание">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </Field>

          <Field label="Исполнитель">
            <Select
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
              options={[{ value: '', label: 'Не назначен' }, ...employees.map((emp) => ({ value: emp.id, label: emp.fullName }))]}
            />
          </Field>

          <Field label="Приоритет">
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              options={(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
            />
          </Field>

          <Field label="Срок">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>

          {error && <Alert tone="danger">{error}</Alert>}

          <Button type="submit" variant="primary" block disabled={submitting} loading={submitting}>
            Создать задачу
          </Button>
        </form>
      </div>
    </div>
    </OverlayPortal>
  );
}

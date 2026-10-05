'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type {
  CreateTaskInput,
  EmployeeSummary,
  MeetingSummary,
  TaskDetail,
  TaskPriority,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { useAuth } from '@/lib/auth-context';
import { PRIORITY_LABELS } from '@/lib/labels';
import { Field, Input, Textarea, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/card';

function NewTaskForm() {
  const router = useRouter();
  const { user } = useAuth();
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [dueDate, setDueDate] = useState('');
  const [sourceMeetingId, setSourceMeetingId] = useState('');
  const [sourceTimestamp, setSourceTimestamp] = useState('');
  const [sourceContext, setSourceContext] = useState('');

  const isOwner = user?.role === 'OWNER';

  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => {});
    // Раздел 9 ТЗ: задачи из встречи ставит только руководитель — сотруднику
    // /meetings всё равно недоступен (403), поэтому даже не запрашиваем.
    if (isOwner) {
      api.get<MeetingSummary[]>('/meetings').then(setMeetings).catch(() => {});
    }
  }, [isOwner]);

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
        sourceMeetingId: sourceMeetingId || undefined,
        sourceTimestamp: sourceTimestamp || undefined,
        sourceContext: sourceContext || undefined,
      };
      const created = await api.post<TaskDetail>('/tasks', payload);
      router.push(`/tasks/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать задачу');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="ds-card" style={{ maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Field label="Название">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </Field>

      <Field label="Описание">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
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

      {isOwner && (
        <>
          <div className="form-section-divider">Источник (раздел 9 ТЗ) — необязательно</div>

          <Field label="Встреча-источник">
            <Select
              value={sourceMeetingId}
              onChange={(e) => setSourceMeetingId(e.target.value)}
              options={[
                { value: '', label: 'Не из встречи' },
                ...meetings.map((m) => ({ value: m.id, label: `${m.title} (${new Date(m.meetingDate).toLocaleDateString('ru-RU')})` })),
              ]}
            />
          </Field>

          {sourceMeetingId && (
            <Field label="Таймкод">
              <Input value={sourceTimestamp} onChange={(e) => setSourceTimestamp(e.target.value)} placeholder="00:14:32" />
            </Field>
          )}

          <Field label="Контекст происхождения (видно исполнителю без доступа к самой встрече)">
            <Textarea
              value={sourceContext}
              onChange={(e) => setSourceContext(e.target.value)}
              rows={2}
              placeholder="Например: обсуждали новый тариф поставщика, нужно учесть в модели"
            />
          </Field>
        </>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
        Создать задачу
      </Button>
    </form>
  );
}

export default function NewTaskPage() {
  return (
    <Protected>
      <Link href="/tasks" className="back-link">
        <ArrowLeft size={14} strokeWidth={1.75} />
        Задачи
      </Link>
      <PageHeader
        title="Новая задача"
        description="Задачу можно поставить любому участнику, включая руководителя. AI-подбор исполнителя появится на Этапе 5."
      />
      <NewTaskForm />
    </Protected>
  );
}

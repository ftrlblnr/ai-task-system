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
    <form onSubmit={handleSubmit} className="card form-card">
      <label>
        Название
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>

      <label>
        Описание
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
      </label>

      <label>
        Исполнитель
        <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Не назначен</option>
          {employees.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.fullName}
            </option>
          ))}
        </select>
      </label>

      <label>
        Приоритет
        <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
          {(Object.keys(PRIORITY_LABELS) as TaskPriority[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </label>

      <label>
        Срок
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </label>

      {isOwner && (
        <>
          <div className="form-section-divider">Источник (раздел 9 ТЗ) — необязательно</div>

          <label>
            Встреча-источник
            <select value={sourceMeetingId} onChange={(e) => setSourceMeetingId(e.target.value)}>
              <option value="">Не из встречи</option>
              {meetings.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title} ({new Date(m.meetingDate).toLocaleDateString('ru-RU')})
                </option>
              ))}
            </select>
          </label>

          {sourceMeetingId && (
            <label>
              Таймкод
              <input
                value={sourceTimestamp}
                onChange={(e) => setSourceTimestamp(e.target.value)}
                placeholder="00:14:32"
              />
            </label>
          )}

          <label>
            Контекст происхождения (видно исполнителю без доступа к самой встрече)
            <textarea
              value={sourceContext}
              onChange={(e) => setSourceContext(e.target.value)}
              rows={2}
              placeholder="Например: обсуждали новый тариф поставщика, нужно учесть в модели"
            />
          </label>
        </>
      )}

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Создаём…' : 'Создать задачу'}
      </button>
    </form>
  );
}

export default function NewTaskPage() {
  return (
    <Protected>
      <Link href="/tasks" className="back-link">
        <ArrowLeft size={14} strokeWidth={2.25} />
        Задачи
      </Link>
      <h1>Новая задача</h1>
      <p className="page-subtitle">
        Задачу можно поставить любому участнику, включая руководителя. AI-подбор исполнителя
        появится на Этапе 5.
      </p>
      <NewTaskForm />
    </Protected>
  );
}

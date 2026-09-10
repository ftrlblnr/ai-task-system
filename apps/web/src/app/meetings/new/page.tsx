'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { CreateMeetingInput, MeetingSummary } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';

function NewMeetingForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [title, setTitle] = useState('');
  const [meetingDate, setMeetingDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rawSummary, setRawSummary] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload: CreateMeetingInput = {
        title,
        meetingDate: new Date(meetingDate).toISOString(),
        rawSummary,
      };
      const created = await api.post<MeetingSummary>('/meetings', payload);
      router.push(`/meetings/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить встречу');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card form-card form-wide">
      <label>
        Название встречи
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Синк по проекту, 28.08" required />
      </label>

      <label>
        Дата встречи
        <input type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} required />
      </label>

      <label>
        Саммари (как есть из Plaud, включая метки Speaker N — заменить их на имена
        сможет AI на Этапе 4)
        <textarea value={rawSummary} onChange={(e) => setRawSummary(e.target.value)} rows={14} required />
      </label>

      {error && <p className="error">{error}</p>}

      <button type="submit" disabled={submitting}>
        {submitting ? 'Сохраняем…' : 'Сохранить встречу'}
      </button>
    </form>
  );
}

export default function NewMeetingPage() {
  return (
    <Protected requireRole="OWNER">
      <Link href="/meetings" className="back-link">
        <ArrowLeft size={14} strokeWidth={2.25} />
        Встречи
      </Link>
      <h1>Новая встреча</h1>
      <p className="page-subtitle">
        Ручная загрузка (Этап 3 ТЗ) — вставьте текст саммари как есть, без правок. Оригинал
        сохраняется без изменений. Транскрипт не хранится — Plaud уже делает саммари сам.
      </p>
      <NewMeetingForm />
    </Protected>
  );
}

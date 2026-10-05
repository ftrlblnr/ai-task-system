'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { CreateMeetingInput, MeetingSummary } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Field, Input, Textarea } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

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
    <form onSubmit={handleSubmit} className="ds-card form-wide" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Field label="Название встречи">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например: Синк по проекту, 28.08" required />
      </Field>

      <Field label="Дата встречи">
        <Input type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} required />
      </Field>

      <Field label="Саммари (как есть из Plaud, включая метки Speaker N — заменить их на имена сможет AI на Этапе 4)">
        <Textarea value={rawSummary} onChange={(e) => setRawSummary(e.target.value)} rows={14} required />
      </Field>

      {error && <Alert tone="danger">{error}</Alert>}

      <Button type="submit" variant="primary" disabled={submitting} loading={submitting}>
        Сохранить встречу
      </Button>
    </form>
  );
}

export default function NewMeetingPage() {
  return (
    <Protected requireRole="OWNER">
      <Link href="/meetings" className="back-link">
        <ArrowLeft size={14} strokeWidth={1.75} />
        Встречи
      </Link>
      <PageHeader
        title="Новая встреча"
        description="Ручная загрузка (Этап 3 ТЗ) — вставьте текст саммари как есть, без правок. Оригинал сохраняется без изменений. Транскрипт не хранится — Plaud уже делает саммари сам."
      />
      <NewMeetingForm />
    </Protected>
  );
}

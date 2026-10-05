'use client';

import { useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import type {
  CreateReceptionRequestInput,
  EditReceptionRequestInput,
  ReceptionRequestItem,
  ReceptionRequestType,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { OverlayPortal } from './overlay-portal';
import { haptic } from '@/lib/telegram';
import { Field, Input, Textarea, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

// ТЗ «Приёмная руководителя» v1.0 (02.10.2026), раздел 8 — подача/
// редактирование. Порт apps/web/src/app/reception/page.tsx:RequestForm в
// стилистику оверлея Mini App (тот же приём, что task-create-overlay.tsx).
const REQUEST_TYPE_LABELS: Record<ReceptionRequestType, string> = {
  DECISION: 'Решение',
  APPROVAL: 'Согласование',
  DISCUSSION: 'Обсуждение',
  HELP: 'Помощь',
};
const EXPECTED_MINUTES_OPTIONS = [5, 10, 15, 30];

export function ReceptionFormOverlay({
  editing,
  onClose,
  onSaved,
}: {
  editing: ReceptionRequestItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(editing?.title ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [requestType, setRequestType] = useState<ReceptionRequestType>(editing?.requestType ?? 'DISCUSSION');
  const [expectedMinutes, setExpectedMinutes] = useState(editing?.expectedMinutes ? String(editing.expectedMinutes) : '');
  const [desiredBy, setDesiredBy] = useState(editing?.desiredBy ? editing.desiredBy.slice(0, 16) : '');
  const [urgencyReason, setUrgencyReason] = useState(editing?.urgencyReason ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (desiredBy && !urgencyReason.trim()) {
      setError('При указании срока укажите причину срочности');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const payload: CreateReceptionRequestInput = {
        title: title.trim(),
        description: description.trim(),
        requestType,
        expectedMinutes: expectedMinutes ? Number(expectedMinutes) : undefined,
        desiredBy: desiredBy ? new Date(desiredBy).toISOString() : undefined,
        urgencyReason: desiredBy ? urgencyReason.trim() : undefined,
      };
      const headers = { 'Idempotency-Key': crypto.randomUUID() };
      if (editing) {
        const editPayload: EditReceptionRequestInput = { ...payload, version: editing.version };
        await api.patch(`/reception/requests/${editing.id}`, editPayload, headers);
      } else {
        await api.post('/reception/requests', payload, headers);
      }
      haptic('medium');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить обращение');
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
          <strong>{editing ? 'Изменить обращение' : 'Подать вопрос'}</strong>
        </div>
        <div className="overlay-body">
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Field label="Тема">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} minLength={5} maxLength={150} required />
            </Field>

            <Field label="Описание вопроса">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} minLength={10} maxLength={3000} rows={4} required />
            </Field>

            <Field label="Что требуется">
              <Select
                value={requestType}
                onChange={(e) => setRequestType(e.target.value as ReceptionRequestType)}
                options={Object.entries(REQUEST_TYPE_LABELS).map(([k, label]) => ({ value: k, label }))}
              />
            </Field>

            <Field label="Ожидаемая длительность">
              <Select
                value={expectedMinutes}
                onChange={(e) => setExpectedMinutes(e.target.value)}
                options={[{ value: '', label: 'Не указано' }, ...EXPECTED_MINUTES_OPTIONS.map((m) => ({ value: String(m), label: `${m} мин` }))]}
              />
            </Field>

            <Field label="Нужен ответ до (необязательно)">
              <Input type="datetime-local" value={desiredBy} onChange={(e) => setDesiredBy(e.target.value)} />
            </Field>

            {desiredBy && (
              <Field label="Причина срочности">
                <Input value={urgencyReason} onChange={(e) => setUrgencyReason(e.target.value)} minLength={5} maxLength={500} required />
              </Field>
            )}

            {error && <Alert tone="danger">{error}</Alert>}

            <Button type="submit" variant="primary" block disabled={submitting} loading={submitting}>
              {editing ? 'Сохранить' : 'Подать вопрос'}
            </Button>
          </form>
        </div>
      </div>
    </OverlayPortal>
  );
}

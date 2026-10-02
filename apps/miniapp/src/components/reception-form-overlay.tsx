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
          <form onSubmit={handleSubmit}>
            <label className="field-label">
              Тема
              <input value={title} onChange={(e) => setTitle(e.target.value)} minLength={5} maxLength={150} required />
            </label>

            <label className="field-label">
              Описание вопроса
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} minLength={10} maxLength={3000} rows={4} required />
            </label>

            <label className="field-label">
              Что требуется
              <select value={requestType} onChange={(e) => setRequestType(e.target.value as ReceptionRequestType)}>
                {Object.entries(REQUEST_TYPE_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field-label">
              Ожидаемая длительность
              <select value={expectedMinutes} onChange={(e) => setExpectedMinutes(e.target.value)}>
                <option value="">Не указано</option>
                {EXPECTED_MINUTES_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} мин
                  </option>
                ))}
              </select>
            </label>

            <label className="field-label">
              Нужен ответ до (необязательно)
              <input type="datetime-local" value={desiredBy} onChange={(e) => setDesiredBy(e.target.value)} />
            </label>

            {desiredBy && (
              <label className="field-label">
                Причина срочности
                <input value={urgencyReason} onChange={(e) => setUrgencyReason(e.target.value)} minLength={5} maxLength={500} required />
              </label>
            )}

            {error && <p className="error">{error}</p>}

            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Сохраняем…' : editing ? 'Сохранить' : 'Подать вопрос'}
            </button>
          </form>
        </div>
      </div>
    </OverlayPortal>
  );
}

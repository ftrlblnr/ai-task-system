'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Plane, Upload } from 'lucide-react';
import type { AgentRunDetail, TripSummary, TripTimeStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/telegram';
import { TripDetailOverlay } from './trip-detail-overlay';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { FileChip } from '@/components/ui/file-chip';

// Агент поездок (ТЗ 08.10.2026) — мобильный компаньон, режим "В дороге":
// список всех поездок компактно, ближайшее событие конкретной поездки
// считается уже внутри TripDetailOverlay (там есть полная программа,
// список здесь её не знает — раздел 11 ТЗ про "В дороге").
const STATUS_LABELS: Record<TripTimeStatus, string> = {
  ONGOING: 'Идёт сейчас',
  UPCOMING: 'Скоро',
  NO_CONFIRMED_DATES: 'Без дат',
  COMPLETED: 'Завершена',
  CANCELLED: 'Отменена',
};
const STATUS_TONE: Record<TripTimeStatus, BadgeTone> = {
  ONGOING: 'warn',
  UPCOMING: 'info',
  NO_CONFIRMED_DATES: 'neutral',
  COMPLETED: 'ok',
  CANCELLED: 'danger',
};
const RUN_TERMINAL = new Set(['READY', 'READY_WITH_ISSUES', 'FAILED']);

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
}

function useIdempotencyKey(): { key: () => string; reset: () => void } {
  const ref = useRef<string | null>(null);
  return {
    key: () => {
      if (!ref.current) ref.current = crypto.randomUUID();
      return ref.current;
    },
    reset: () => {
      ref.current = null;
    },
  };
}

export function TripsScreen({ active = true }: { active?: boolean }) {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTripId, setOpenTripId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function load() {
    api
      .get<TripSummary[]>('/trips')
      .then((items) => {
        setTrips(items);
        setError(null);
      })
      .catch(() => setError('Не удалось загрузить поездки'));
  }

  useEffect(() => {
    if (active) load();
  }, [active]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function onFilesSelected(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    setFiles((prev) => [...prev, ...picked]);
  }

  function pollRun(runId: string) {
    pollRef.current = setInterval(async () => {
      try {
        const run = await api.get<AgentRunDetail>(`/trips/runs/${runId}`);
        if (RUN_TERMINAL.has(run.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          setSubmitting(false);
          if (run.status !== 'FAILED' && run.tripId) {
            haptic('medium');
            setCreating(false);
            setFiles([]);
            idem.reset();
            load();
            setOpenTripId(run.tripId);
          } else {
            setCreateError(run.errorSummary ?? 'Не удалось обработать материалы');
          }
        }
      } catch {
        // сбой одного тика опроса — пробуем дальше
      }
    }, 2000);
  }

  async function handleCreate() {
    if (files.length === 0) {
      setCreateError('Прикрепите хотя бы один материал');
      return;
    }
    setSubmitting(true);
    setCreateError(null);
    try {
      const formData = new FormData();
      for (const f of files) formData.append('files', f);
      const run = await api.postForm<AgentRunDetail>('/trips/runs', formData, { 'Idempotency-Key': idem.key() });
      if (RUN_TERMINAL.has(run.status)) {
        setSubmitting(false);
        if (run.status !== 'FAILED' && run.tripId) {
          setCreating(false);
          setFiles([]);
          load();
          setOpenTripId(run.tripId);
        } else {
          setCreateError(run.errorSummary ?? 'Не удалось обработать материалы');
        }
      } else {
        pollRun(run.id);
      }
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : 'Не удалось создать пакет материалов');
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '10px 0 4px' }}>
        <h1>Поездки</h1>
        <button
          onClick={() => setCreating((v) => !v)}
          aria-label="Собрать поездку из материалов"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-contrast)' }}
        >
          <Plane size={16} strokeWidth={2.5} />
        </button>
      </div>

      {creating && (
        <div className="task-card" style={{ display: 'block', marginBottom: 12 }}>
          {createError && <Alert tone="danger">{createError}</Alert>}
          {submitting ? (
            <Alert tone="info">Обрабатываем материалы…</Alert>
          ) : (
            <>
              <label className="ds-btn ds-btn-secondary" style={{ display: 'inline-flex', cursor: 'pointer' }}>
                <Upload size={16} strokeWidth={1.75} />
                Прикрепить материалы
                <input type="file" multiple hidden onChange={onFilesSelected} accept=".pdf,.docx,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.webp,.gif" />
              </label>
              {files.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {files.map((f, idx) => (
                    <FileChip key={`${f.name}-${idx}`} name={f.name} onRemove={() => setFiles((prev) => prev.filter((_, i) => i !== idx))} />
                  ))}
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                <Button variant="primary" size="sm" onClick={handleCreate}>
                  Собрать поездку
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}
      {!trips && !error && <p className="ds-field-hint">Загрузка…</p>}
      {trips && trips.length === 0 && !creating && <EmptyState icon={Plane} title="Пока нет ни одной поездки" />}

      {trips?.map((trip) => (
        <button key={trip.id} className="task-card" style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => setOpenTripId(trip.id)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="task-card-title">{trip.title}</span>
            <Badge tone={STATUS_TONE[trip.timeStatus]}>{STATUS_LABELS[trip.timeStatus]}</Badge>
          </div>
          <div className="ds-field-hint" style={{ marginTop: 4 }}>
            {trip.periodStart ? formatDate(trip.periodStart) : 'Даты не подтверждены'}
            {trip.periodEnd && trip.periodEnd !== trip.periodStart ? ` — ${formatDate(trip.periodEnd)}` : ''}
          </div>
        </button>
      ))}

      {openTripId && <TripDetailOverlay tripId={openTripId} onClose={() => setOpenTripId(null)} onChanged={load} />}
    </div>
  );
}

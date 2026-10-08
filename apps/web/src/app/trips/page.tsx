'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Plane, Upload, Plus } from 'lucide-react';
import type { AgentRunDetail, CreateTripInput, TripSummary, TripTimeStatus } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { Protected } from '@/components/protected';
import { Card, PageHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { FileChip } from '@/components/ui/file-chip';

// Раздел 4 ТЗ — "статус времени поездки и готовность информации — разные
// признаки": группировка списка по timeStatus (вычисляется на бэкенде из
// дат), не по тому, сколько фактов удалось извлечь.
const SECTION_ORDER: TripTimeStatus[] = ['ONGOING', 'UPCOMING', 'NO_CONFIRMED_DATES', 'COMPLETED', 'CANCELLED'];
const SECTION_LABELS: Record<TripTimeStatus, string> = {
  ONGOING: 'Идёт сейчас',
  UPCOMING: 'Скоро',
  NO_CONFIRMED_DATES: 'Без подтверждённых дат',
  COMPLETED: 'Завершённые',
  CANCELLED: 'Отменённые',
};
const STATUS_BADGE_TONE: Record<TripTimeStatus, BadgeTone> = {
  ONGOING: 'warn',
  UPCOMING: 'info',
  NO_CONFIRMED_DATES: 'neutral',
  COMPLETED: 'ok',
  CANCELLED: 'danger',
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
}

function formatPeriod(trip: TripSummary): string {
  if (trip.periodPrecision === 'UNKNOWN' || !trip.periodStart) return 'Даты не подтверждены';
  const start = formatDate(trip.periodStart);
  const end = trip.periodEnd ? formatDate(trip.periodEnd) : null;
  const prefix = trip.periodPrecision === 'APPROXIMATE' ? '≈ ' : '';
  return end && end !== start ? `${prefix}${start} — ${end}` : `${prefix}${start}`;
}

// Раздел 18 ТЗ — тот же приём, что reception/calendar: один ключ на
// попытку, переиспользуется при повторе того же действия.
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

const POLL_MS = 2_000;
const TERMINAL_STATUSES = new Set(['READY', 'READY_WITH_ISSUES', 'FAILED']);

function CreateTripDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (tripId: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const idem = useIdempotencyKey();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function onFilesSelected(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    setFiles((prev) => [...prev, ...picked]);
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function pollRun(runId: string) {
    pollRef.current = setInterval(async () => {
      try {
        const run = await api.get<AgentRunDetail>(`/trips/runs/${runId}`);
        setRunStatus(run.status);
        if (TERMINAL_STATUSES.has(run.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          if (run.status !== 'FAILED' && run.tripId) {
            onCreated(run.tripId);
          } else {
            // run.status==='FAILED', либо (редкий случай) терминальный статус без
            // tripId — например, поездка этого прогона была удалена отдельно.
            // В обоих случаях диалог не должен молча висеть на "Обрабатываем…".
            setError(run.errorSummary ?? 'Не удалось обработать материалы');
            setSubmitting(false);
          }
        }
      } catch {
        // сетевой сбой одного тика опроса — не прерываем, следующий тик попробует снова
      }
    }, POLL_MS);
  }

  async function handleSubmit() {
    if (files.length === 0) {
      setError('Прикрепите хотя бы один материал — билет, программу, приглашение, скриншот');
      return;
    }
    setSubmitting(true);
    setError(null);
    setRunStatus('RECEIVED');
    try {
      const formData = new FormData();
      for (const f of files) formData.append('files', f);
      const run = await api.postForm<AgentRunDetail>('/trips/runs', formData, { 'Idempotency-Key': idem.key() });
      setRunStatus(run.status);
      if (TERMINAL_STATUSES.has(run.status)) {
        if (run.status !== 'FAILED' && run.tripId) {
          onCreated(run.tripId);
        } else {
          setError(run.errorSummary ?? 'Не удалось обработать материалы');
          setSubmitting(false);
        }
      } else {
        pollRun(run.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать пакет материалов');
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title="Собрать поездку из материалов"
      description="Билеты, программа, приглашение, скриншоты переписки — карточка появится сразу, даже если материалов пока немного."
      onClose={submitting ? undefined : onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={submitting}>
            {submitting ? 'Обрабатываем…' : 'Собрать поездку'}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {submitting && runStatus && !error && (
        <Alert tone="info">
          {runStatus === 'RECEIVED' && 'Материалы приняты, начинаем обработку…'}
          {runStatus === 'EXTRACTING' && 'Извлекаем факты из материалов…'}
          {runStatus === 'MATCHING' && 'Проверяем, нет ли уже такой поездки…'}
          {runStatus === 'COMPOSING' && 'Собираем карточку поездки…'}
        </Alert>
      )}
      {!submitting && (
        <>
          <label className="ds-btn ds-btn-secondary" style={{ display: 'inline-flex', cursor: 'pointer' }}>
            <Upload size={18} strokeWidth={1.75} />
            Прикрепить материалы
            <input type="file" multiple hidden onChange={onFilesSelected} accept=".pdf,.docx,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.webp,.gif" />
          </label>
          {files.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {files.map((f, idx) => (
                <FileChip key={`${f.name}-${idx}`} name={f.name} onRemove={() => removeFile(idx)} />
              ))}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

// Полный CRUD — создание карточки напрямую, без материалов. Второстепенное
// действие (основной путь — "Собрать из материалов", раздел 3 ТЗ), поэтому
// кнопка secondary, без Idempotency-Key (не файловая загрузка, двойной
// клик создаёт максимум лишнюю карточку, не дублирующий дорогой AgentRun).
function CreateTripManualDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (tripId: string) => void }) {
  const [title, setTitle] = useState('');
  const [purposeSummary, setPurposeSummary] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    if (!title.trim()) {
      setError('Укажите название поездки');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: CreateTripInput = { title: title.trim(), purposeSummary: purposeSummary.trim() || undefined, periodStart: periodStart || undefined, periodEnd: periodEnd || undefined };
      const trip = await api.post<TripSummary>('/trips', payload);
      onCreated(trip.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать поездку');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Создать поездку вручную"
      description="Без материалов — просто карточка, которую можно дополнить позже."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={busy}>
            Создать
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Название">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Цель поездки (необязательно)">
        <Textarea value={purposeSummary} onChange={(e) => setPurposeSummary(e.target.value)} />
      </Field>
      <Field label="Начало (необязательно)">
        <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
      </Field>
      <Field label="Окончание (необязательно)">
        <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function TripRow({ trip, onOpen }: { trip: TripSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="ds-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', textAlign: 'left', cursor: 'pointer', gap: 12 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>{trip.title}</strong>
          <Badge tone="outline">{trip.humanCode}</Badge>
        </div>
        <p className="ds-field-hint" style={{ margin: '4px 0 0' }}>
          {formatPeriod(trip)}
          {trip.purposeSummary ? ` · ${trip.purposeSummary}` : ''}
        </p>
      </div>
      <Badge tone={STATUS_BADGE_TONE[trip.timeStatus]}>{SECTION_LABELS[trip.timeStatus]}</Badge>
    </button>
  );
}

function TripsView() {
  const router = useRouter();
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingManual, setCreatingManual] = useState(false);

  const load = useCallback(() => {
    api
      .get<TripSummary[]>('/trips')
      .then((items) => {
        setTrips(items);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить поездки'));
  }, []);

  useEffect(load, [load]);

  const sections = SECTION_ORDER.map((status) => ({ status, items: (trips ?? []).filter((t) => t.timeStatus === status) })).filter((s) => s.items.length > 0);

  return (
    <>
      <PageHeader
        title="Поездки"
        description="Соберите поездку из материалов — билетов, программы, приглашения, скриншотов"
        actions={
          <>
            <Button variant="ghost" icon={Plus} onClick={() => setCreatingManual(true)}>
              Создать вручную
            </Button>
            <Button variant="primary" icon={Plane} onClick={() => setCreating(true)}>
              Собрать из материалов
            </Button>
          </>
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {!trips && !error && <p className="ds-field-hint">Загрузка…</p>}
      {trips && trips.length === 0 && (
        <EmptyState icon={Plane} title="Пока нет ни одной поездки" description="Нажмите «Собрать из материалов» и прикрепите билет, программу или приглашение." />
      )}
      {sections.map(({ status, items }) => (
        <Card key={status} title={SECTION_LABELS[status]} style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((trip) => (
              <TripRow key={trip.id} trip={trip} onOpen={() => router.push(`/trips/${trip.id}`)} />
            ))}
          </div>
        </Card>
      ))}
      {creating && (
        <CreateTripDialog
          onClose={() => setCreating(false)}
          onCreated={(tripId) => {
            setCreating(false);
            router.push(`/trips/${tripId}`);
          }}
        />
      )}
      {creatingManual && (
        <CreateTripManualDialog
          onClose={() => setCreatingManual(false)}
          onCreated={(tripId) => {
            setCreatingManual(false);
            router.push(`/trips/${tripId}`);
          }}
        />
      )}
    </>
  );
}

export default function TripsPage() {
  return (
    <Protected>
      <TripsView />
    </Protected>
  );
}

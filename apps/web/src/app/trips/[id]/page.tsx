'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Upload, Plane, Hotel, Calendar as CalendarIcon, Users as UsersIcon, History as HistoryIcon, FileText, Plus, Trash2 } from 'lucide-react';
import type {
  AddTripMemberInput,
  AgentRunDetail,
  CreateExtractedFactInput,
  CreateTripContactInput,
  CreateTripEventInput,
  CreateTripLegInput,
  CreateTripStayInput,
  EmployeeSummary,
  ProposedChangeItem,
  ProposeTripTaskInput,
  TripAccessRole,
  TripDetail,
  TripLegItem,
  TripEventItem,
  TripStayItem,
  TripRevisionItem,
} from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Protected } from '@/components/protected';
import { Card, PageHeader } from '@/components/ui/card';
import { Button, IconButton } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { EmptyState } from '@/components/ui/empty-state';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { FileChip } from '@/components/ui/file-chip';

type Tab = 'overview' | 'program' | 'changes' | 'people' | 'history';

const BOOKING_LABELS: Record<string, string> = { BOOKED: 'Забронировано', PROPOSED: 'Предложено', UNCONFIRMED: 'Подтверждения не найдено' };
const BOOKING_TONE: Record<string, BadgeTone> = { BOOKED: 'ok', PROPOSED: 'info', UNCONFIRMED: 'warn' };
const LEG_MODE_LABELS: Record<string, string> = { FLIGHT: 'Перелёт', TRAIN: 'Поезд', CAR: 'Автомобиль', OTHER: 'Переезд' };
const ACCESS_ROLE_LABELS: Record<TripAccessRole, string> = { ORGANIZER: 'Организатор', EDITOR: 'Редактор', APPROVER: 'Утверждающий', VIEWER: 'Наблюдатель' };
const CONTACT_ROLE_LABELS: Record<string, string> = { ORGANIZER_HOST: 'Принимающая сторона', RECEIVING_PARTY: 'Принимающая сторона', DELEGATE: 'Представитель', OTHER: 'Контакт' };
const RUN_TERMINAL = new Set(['READY', 'READY_WITH_ISSUES', 'FAILED']);

function fmtDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}
function fmtDate(value: string | null): string {
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

// Раздел 7 ТЗ — ручная правка отдельна от предложений агента: полные формы
// редактирования каждого поля намеренно не строим (основной путь внесения
// исправлений — approve/reject предложений или новый материал), но удалить
// явно неверный/дублирующий пункт программы вручную — быть должно.
function DeleteButton({ onConfirm, confirmText }: { onConfirm: () => void; confirmText: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={busy}
      onClick={async () => {
        if (!window.confirm(confirmText)) return;
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
        }
      }}
    >
      Удалить
    </Button>
  );
}

function LegRow({ leg, canEdit, onDeleted }: { leg: TripLegItem; canEdit: boolean; onDeleted: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    try {
      await api.delete(`/trips/${leg.tripId}/legs/${leg.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить');
    }
  }
  return (
    <Card tone="sunken">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Plane size={16} strokeWidth={1.75} />
            <strong>{LEG_MODE_LABELS[leg.mode]}</strong>
            <span>
              {leg.fromLocation ?? '?'} → {leg.toLocation ?? '?'}
            </span>
          </div>
          <p className="ds-field-hint" style={{ margin: '4px 0 0' }}>
            {leg.departAt ? fmtDateTime(leg.departAt) : 'Время вылета/отправления не подтверждено'}
            {leg.arriveAt ? ` → ${fmtDateTime(leg.arriveAt)}` : ''}
            {leg.carrier ? ` · ${leg.carrier}` : ''}
            {leg.referenceCode ? ` · ${leg.referenceCode}` : ''}
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <Badge tone={BOOKING_TONE[leg.bookingStatus]}>{BOOKING_LABELS[leg.bookingStatus]}</Badge>
          {canEdit && <DeleteButton onConfirm={remove} confirmText="Удалить этот перелёт/переезд из программы?" />}
        </div>
      </div>
    </Card>
  );
}

function StayRow({ stay, canEdit, onDeleted }: { stay: TripStayItem; canEdit: boolean; onDeleted: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    try {
      await api.delete(`/trips/${stay.tripId}/stays/${stay.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить');
    }
  }
  return (
    <Card tone="sunken">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Hotel size={16} strokeWidth={1.75} />
            <strong>{stay.name ?? 'Проживание'}</strong>
          </div>
          <p className="ds-field-hint" style={{ margin: '4px 0 0' }}>
            {stay.address ?? 'Адрес не указан'}
            {stay.checkInAt ? ` · заезд ${fmtDateTime(stay.checkInAt)}` : ''}
            {stay.checkOutAt ? ` · выезд ${fmtDateTime(stay.checkOutAt)}` : ''}
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <Badge tone={BOOKING_TONE[stay.bookingStatus]}>{BOOKING_LABELS[stay.bookingStatus]}</Badge>
          {canEdit && <DeleteButton onConfirm={remove} confirmText="Удалить это проживание из программы?" />}
        </div>
      </div>
    </Card>
  );
}

function EventRow({
  event,
  canWriteCalendar,
  canEdit,
  onAddedToCalendar,
  onDeleted,
}: {
  event: TripEventItem;
  canWriteCalendar: boolean;
  canEdit: boolean;
  onAddedToCalendar: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addToCalendar() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/trips/${event.tripId}/events/${event.id}/add-to-calendar`);
      onAddedToCalendar();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить в календарь');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    try {
      await api.delete(`/trips/${event.tripId}/events/${event.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить');
    }
  }

  return (
    <Card tone="sunken">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CalendarIcon size={16} strokeWidth={1.75} />
            <strong>{event.title}</strong>
          </div>
          <p className="ds-field-hint" style={{ margin: '4px 0 0' }}>
            {event.startAt ? fmtDateTime(event.startAt) : event.dateOnly ? `${fmtDate(event.dateOnly)} · время не подтверждено` : 'Дата не подтверждена'}
            {event.location ? ` · ${event.location}` : ''}
          </p>
          {event.notes && <p className="ds-field-hint" style={{ margin: '2px 0 0' }}>{event.notes}</p>}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          {canWriteCalendar && event.startAt && event.endAt && (
            <Button size="sm" variant="ghost" onClick={addToCalendar} loading={busy}>
              В календарь
            </Button>
          )}
          {canEdit && <DeleteButton onConfirm={remove} confirmText="Удалить это событие из программы?" />}
        </div>
      </div>
    </Card>
  );
}

function ChangeRow({ change, canApprove, onResolved }: { change: ProposedChangeItem; canApprove: boolean; onResolved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(action: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/trips/${change.tripId}/changes/${change.id}/${action}`);
      onResolved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось применить решение');
    } finally {
      setBusy(false);
    }
  }

  const describeEntity: Record<string, string> = { TRIP: 'Поездка', TRIP_LEG: 'Перелёт/переезд', TRIP_EVENT: 'Событие программы', TRIP_STAY: 'Проживание', TRIP_CONTACT: 'Контакт' };

  return (
    <Card tone="sunken">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <Badge tone="info">{describeEntity[change.entityType]}</Badge>
          {change.reason && <p style={{ margin: '8px 0 0' }}>{change.reason}</p>}
          {change.consequences && <p className="ds-field-hint" style={{ margin: '4px 0 0' }}>{change.consequences}</p>}
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8, background: 'var(--ds-sunken, #f5f5f5)', padding: 8, borderRadius: 6 }}>
            {JSON.stringify(change.proposedValue, null, 2)}
          </pre>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
        {canApprove && change.status === 'PENDING' && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <Button size="sm" variant="ghost" onClick={() => resolve('reject')} loading={busy}>
              Отклонить
            </Button>
            <Button size="sm" variant="primary" onClick={() => resolve('approve')} loading={busy}>
              Подтвердить
            </Button>
          </div>
        )}
        {change.status !== 'PENDING' && <Badge tone={change.status === 'APPLIED' ? 'ok' : 'neutral'}>{change.status === 'APPLIED' ? 'Применено' : 'Отклонено'}</Badge>}
      </div>
    </Card>
  );
}

function AddMaterialsDialog({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  function pollRun(runId: string) {
    pollRef.current = setInterval(async () => {
      try {
        const run = await api.get<AgentRunDetail>(`/trips/runs/${runId}`);
        if (RUN_TERMINAL.has(run.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          if (run.status === 'FAILED') {
            setError(run.errorSummary ?? 'Не удалось обработать материалы');
            setSubmitting(false);
          } else {
            onDone();
          }
        }
      } catch {
        // сбой одного тика опроса — пробуем дальше
      }
    }, 2000);
  }

  async function handleSubmit() {
    if (files.length === 0) {
      setError('Прикрепите хотя бы один материал');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData();
      for (const f of files) formData.append('files', f);
      const run = await api.postForm<AgentRunDetail>(`/trips/${tripId}/materials`, formData, { 'Idempotency-Key': idem.key() });
      if (RUN_TERMINAL.has(run.status)) {
        if (run.status === 'FAILED') {
          setError(run.errorSummary ?? 'Не удалось обработать материалы');
          setSubmitting(false);
        } else {
          onDone();
        }
      } else {
        pollRun(run.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить материалы');
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      title="Добавить материалы"
      description="Новые факты станут предложениями на вкладке «Изменения» — ничего не изменится в карточке без подтверждения."
      onClose={submitting ? undefined : onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={submitting}>
            Добавить
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
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
                <FileChip key={`${f.name}-${idx}`} name={f.name} onRemove={() => setFiles((prev) => prev.filter((_, i) => i !== idx))} />
              ))}
            </div>
          )}
        </>
      )}
      {submitting && <Alert tone="info">Обрабатываем материалы…</Alert>}
    </Dialog>
  );
}

function AddMemberDialog({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [role, setRole] = useState<TripAccessRole>('VIEWER');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => undefined);
  }, []);

  async function handleSubmit() {
    if (!employeeId) {
      setError('Выберите сотрудника');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post<unknown>(`/trips/${tripId}/members`, { employeeId, accessRole: role } satisfies AddTripMemberInput);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить участника');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Добавить участника"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={busy}>
            Добавить
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Сотрудник">
        <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} options={[{ value: '', label: 'Выберите…' }, ...employees.map((e) => ({ value: e.id, label: e.fullName }))]} />
      </Field>
      <Field label="Роль в поездке">
        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as TripAccessRole)}
          options={Object.entries(ACCESS_ROLE_LABELS).map(([value, label]) => ({ value, label }))}
        />
      </Field>
    </Dialog>
  );
}

function ProposeTaskDialog({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<EmployeeSummary[]>('/employees').then(setEmployees).catch(() => undefined);
  }, []);

  async function handleSubmit() {
    if (!title || !assigneeId || !dueDate) {
      setError('Заполните название, исполнителя и срок — без них задача не создаётся');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post<unknown>(`/trips/${tripId}/tasks`, { title, assigneeId, dueDate } satisfies ProposeTripTaskInput);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать задачу');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Создать задачу"
      description="Исполнитель и срок — обязательны, агент их не придумывает."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={busy}>
            Создать
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Название задачи">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Исполнитель">
        <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} options={[{ value: '', label: 'Выберите…' }, ...employees.map((e) => ({ value: e.id, label: e.fullName }))]} />
      </Field>
      <Field label="Срок">
        <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </Field>
    </Dialog>
  );
}

// Полный CRUD — ручное добавление пункта программы без материала. Намеренно
// без каждого опционального поля формы (например, часовых поясов отдельно
// от самой даты) — то, что не покрыто формой, всегда доступно через PATCH
// позже; это не ограничение API, только сознательно упрощённая форма.
function CreateLegDialog({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [fromLocation, setFromLocation] = useState('');
  const [toLocation, setToLocation] = useState('');
  const [departAt, setDepartAt] = useState('');
  const [arriveAt, setArriveAt] = useState('');
  const [carrier, setCarrier] = useState('');
  const [bookingStatus, setBookingStatus] = useState<CreateTripLegInput['bookingStatus']>('UNCONFIRMED');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      const payload: CreateTripLegInput = {
        mode: 'FLIGHT',
        fromLocation: fromLocation || undefined,
        toLocation: toLocation || undefined,
        departAt: departAt || undefined,
        arriveAt: arriveAt || undefined,
        carrier: carrier || undefined,
        bookingStatus,
      };
      await api.post(`/trips/${tripId}/legs`, payload);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить перелёт/переезд');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Добавить перелёт/переезд"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={busy}>
            Добавить
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Откуда">
        <Input value={fromLocation} onChange={(e) => setFromLocation(e.target.value)} />
      </Field>
      <Field label="Куда">
        <Input value={toLocation} onChange={(e) => setToLocation(e.target.value)} />
      </Field>
      <Field label="Вылет/отправление (если известно)">
        <Input type="datetime-local" value={departAt} onChange={(e) => setDepartAt(e.target.value)} />
      </Field>
      <Field label="Прилёт/прибытие (если известно)">
        <Input type="datetime-local" value={arriveAt} onChange={(e) => setArriveAt(e.target.value)} />
      </Field>
      <Field label="Перевозчик/номер рейса">
        <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} />
      </Field>
      <Field label="Статус">
        <Select
          value={bookingStatus}
          onChange={(e) => setBookingStatus(e.target.value as CreateTripLegInput['bookingStatus'])}
          options={[
            { value: 'UNCONFIRMED', label: 'Подтверждения не найдено' },
            { value: 'PROPOSED', label: 'Предложено' },
            { value: 'BOOKED', label: 'Забронировано' },
          ]}
        />
      </Field>
    </Dialog>
  );
}

function CreateEventDialog({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [startAt, setStartAt] = useState('');
  const [location, setLocation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    if (!title.trim()) {
      setError('Укажите название события');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: CreateTripEventInput = { title: title.trim(), startAt: startAt || undefined, location: location || undefined };
      await api.post(`/trips/${tripId}/events`, payload);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить событие');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Добавить событие программы"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={busy}>
            Добавить
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Название">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Дата и время (если известно)">
        <Input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
      </Field>
      <Field label="Место">
        <Input value={location} onChange={(e) => setLocation(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function CreateStayDialog({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [checkInAt, setCheckInAt] = useState('');
  const [checkOutAt, setCheckOutAt] = useState('');
  const [bookingStatus, setBookingStatus] = useState<CreateTripStayInput['bookingStatus']>('UNCONFIRMED');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      const payload: CreateTripStayInput = { name: name || undefined, address: address || undefined, checkInAt: checkInAt || undefined, checkOutAt: checkOutAt || undefined, bookingStatus };
      await api.post(`/trips/${tripId}/stays`, payload);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить проживание');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Добавить проживание"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={busy}>
            Добавить
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Название">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Адрес">
        <Input value={address} onChange={(e) => setAddress(e.target.value)} />
      </Field>
      <Field label="Заезд (если известно)">
        <Input type="date" value={checkInAt} onChange={(e) => setCheckInAt(e.target.value)} />
      </Field>
      <Field label="Выезд (если известно)">
        <Input type="date" value={checkOutAt} onChange={(e) => setCheckOutAt(e.target.value)} />
      </Field>
      <Field label="Статус">
        <Select
          value={bookingStatus}
          onChange={(e) => setBookingStatus(e.target.value as CreateTripStayInput['bookingStatus'])}
          options={[
            { value: 'UNCONFIRMED', label: 'Подтверждения не найдено' },
            { value: 'PROPOSED', label: 'Предложено' },
            { value: 'BOOKED', label: 'Забронировано' },
          ]}
        />
      </Field>
    </Dialog>
  );
}

function CreateContactDialog({ tripId, onClose, onDone }: { tripId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<CreateTripContactInput['role']>('OTHER');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    if (!name.trim()) {
      setError('Укажите имя контакта');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: CreateTripContactInput = { name: name.trim(), role, phone: phone || undefined, email: email || undefined };
      await api.post(`/trips/${tripId}/contacts`, payload);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить контакт');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Добавить контакт"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={busy}>
            Добавить
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Имя">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Роль">
        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as CreateTripContactInput['role'])}
          options={[
            { value: 'OTHER', label: 'Контакт' },
            { value: 'RECEIVING_PARTY', label: 'Принимающая сторона' },
            { value: 'DELEGATE', label: 'Представитель' },
          ]}
        />
      </Field>
      <Field label="Телефон">
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Field label="Email">
        <Input value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
    </Dialog>
  );
}

// Факты — простая форма из двух полей, без модалки (ExtractedFact — самый
// "мягкий" слой данных, не заслуживает отдельного диалога).
function AddFactInline({ tripId, onDone }: { tripId: string; onDone: () => void }) {
  const [factKey, setFactKey] = useState('');
  const [factValue, setFactValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    if (!factKey.trim() || !factValue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const payload: CreateExtractedFactInput = { factKey: factKey.trim(), factValue: factValue.trim() };
      await api.post(`/trips/${tripId}/facts`, payload);
      setFactKey('');
      setFactValue('');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось добавить факт');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Input placeholder="Например, виза" value={factKey} onChange={(e) => setFactKey(e.target.value)} style={{ maxWidth: 180 }} />
        <Input placeholder="Например, нужна" value={factValue} onChange={(e) => setFactValue(e.target.value)} style={{ maxWidth: 220 }} />
        <Button size="sm" icon={Plus} onClick={handleSubmit} loading={busy}>
          Добавить
        </Button>
      </div>
    </div>
  );
}

function TripDetailView({ tripId }: { tripId: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [changes, setChanges] = useState<ProposedChangeItem[] | null>(null);
  const [revisions, setRevisions] = useState<TripRevisionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [showAddMaterials, setShowAddMaterials] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showProposeTask, setShowProposeTask] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showCreateLeg, setShowCreateLeg] = useState(false);
  const [showCreateEvent, setShowCreateEvent] = useState(false);
  const [showCreateStay, setShowCreateStay] = useState(false);
  const [showCreateContact, setShowCreateContact] = useState(false);

  const loadTrip = useCallback(() => {
    api
      .get<TripDetail>(`/trips/${tripId}`)
      .then((t) => {
        setTrip(t);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить поездку'));
  }, [tripId]);

  const loadChanges = useCallback(() => {
    api.get<ProposedChangeItem[]>(`/trips/${tripId}/changes`).then(setChanges).catch(() => undefined);
  }, [tripId]);

  const loadRevisions = useCallback(() => {
    api.get<TripRevisionItem[]>(`/trips/${tripId}/revisions`).then(setRevisions).catch(() => undefined);
  }, [tripId]);

  useEffect(loadTrip, [loadTrip]);
  useEffect(loadChanges, [loadChanges]);
  useEffect(loadRevisions, [loadRevisions]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!trip) return <p className="ds-field-hint">Загрузка…</p>;

  const myMembership = trip.members.find((m) => m.employeeId === user?.id);
  const myRole = myMembership?.accessRole ?? null;
  const canEdit = myRole === 'ORGANIZER' || myRole === 'EDITOR';
  const canApprove = myRole === 'ORGANIZER' || myRole === 'APPROVER';
  const canManageAccess = myRole === 'ORGANIZER';
  const canWriteCalendar = user?.role === 'OWNER';
  const pendingChanges = (changes ?? []).filter((c) => c.status === 'PENDING');

  const programItems = [
    ...trip.legs.map((leg) => ({ sortKey: leg.departAt ?? '9999', node: <LegRow key={`leg-${leg.id}`} leg={leg} canEdit={canEdit} onDeleted={loadTrip} /> })),
    ...trip.events.map((event) => ({
      sortKey: event.startAt ?? event.dateOnly ?? '9999',
      node: <EventRow key={`event-${event.id}`} event={event} canWriteCalendar={canWriteCalendar} canEdit={canEdit} onAddedToCalendar={loadRevisions} onDeleted={loadTrip} />,
    })),
    ...trip.stays.map((stay) => ({ sortKey: stay.checkInAt ?? '9999', node: <StayRow key={`stay-${stay.id}`} stay={stay} canEdit={canEdit} onDeleted={loadTrip} /> })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  async function toggleCancelled() {
    setCancelling(true);
    setCancelError(null);
    try {
      await api.patch(`/trips/${tripId}`, { cancelledAt: trip!.cancelledAt ? null : new Date().toISOString() });
      loadTrip();
      loadRevisions();
    } catch (err) {
      setCancelError(err instanceof ApiError ? err.message : 'Не удалось изменить статус поездки');
    } finally {
      setCancelling(false);
    }
  }

  // Полный CRUD — trips.archive, безвозвратно (в отличие от отмены выше).
  async function handleDeleteTrip() {
    if (!window.confirm('Удалить поездку безвозвратно? Это действие нельзя отменить.')) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.delete(`/trips/${tripId}`);
      router.push('/trips');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Не удалось удалить поездку');
      setDeleting(false);
    }
  }

  return (
    <>
      <Button variant="ghost" icon={ArrowLeft} onClick={() => router.push('/trips')} style={{ marginBottom: 12 }}>
        К списку поездок
      </Button>
      <PageHeader
        title={
          <>
            {trip.title} <Badge tone="outline">{trip.humanCode}</Badge>
          </>
        }
        description={trip.purposeSummary ?? undefined}
      />

      {pendingChanges.length > 0 && (
        <Alert tone="info">
          {pendingChanges.length} {pendingChanges.length === 1 ? 'изменение ожидает' : 'изменений ожидает'} подтверждения —{' '}
          <button type="button" onClick={() => setTab('changes')} style={{ textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            посмотреть
          </button>
        </Alert>
      )}

      <div style={{ margin: '16px 0' }}>
        <SegmentedControl
          options={[
            { value: 'overview', label: 'Обзор' },
            { value: 'program', label: 'Программа' },
            { value: 'changes', label: `Изменения${pendingChanges.length > 0 ? ` (${pendingChanges.length})` : ''}` },
            { value: 'people', label: 'Люди' },
            { value: 'history', label: 'История' },
          ]}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />
      </div>

      {tab === 'overview' && (
        <>
          {canEdit && (
            <Card tone={trip.cancelledAt ? undefined : 'sunken'} style={{ marginBottom: 16 }}>
              {cancelError && <Alert tone="danger">{cancelError}</Alert>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{trip.cancelledAt ? `Поездка отменена ${fmtDateTime(trip.cancelledAt)}` : 'Поездка активна'}</span>
                <Button size="sm" variant={trip.cancelledAt ? 'secondary' : 'danger'} onClick={toggleCancelled} loading={cancelling}>
                  {trip.cancelledAt ? 'Снять отмену' : 'Отменить поездку'}
                </Button>
              </div>
            </Card>
          )}
          {canManageAccess && (
            <Card tone="sunken" style={{ marginBottom: 16 }}>
              {deleteError && <Alert tone="danger">{deleteError}</Alert>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="ds-field-hint">Удаление безвозвратно (в отличие от отмены выше)</span>
                <Button size="sm" variant="danger" icon={Trash2} onClick={handleDeleteTrip} loading={deleting}>
                  Удалить поездку
                </Button>
              </div>
            </Card>
          )}
          <Card title="Материалы" actions={canEdit ? <Button size="sm" icon={Upload} onClick={() => setShowAddMaterials(true)}>Добавить материалы</Button> : undefined}>
            {trip.materials.length === 0 ? (
              <EmptyState icon={FileText} title="Материалов пока нет" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {trip.materials.map((m) => (
                  <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>{m.fileArtifactId}</span>
                    <Badge tone={m.processingStatus === 'EXTRACTED' ? 'ok' : m.processingStatus === 'PENDING' ? 'neutral' : 'warn'}>{m.processingStatus}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Прочие факты" style={{ marginTop: 16 }}>
            {trip.facts.length === 0 ? (
              <p className="ds-field-hint">Фактов пока нет — виза, бюджет, особые требования и т.п.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {trip.facts.map((f) => (
                  <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>
                      <strong>{f.factKey}:</strong> {f.factValue}
                    </span>
                    {canEdit && (
                      <IconButton
                        icon={Trash2}
                        label="Удалить факт"
                        size="sm"
                        variant="ghost"
                        onClick={() => api.delete(`/trips/${tripId}/facts/${f.id}`).then(loadTrip)}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            {canEdit && <AddFactInline tripId={tripId} onDone={loadTrip} />}
          </Card>
          {canEdit && (
            <Card title="Задачи по поездке" style={{ marginTop: 16 }} actions={<Button size="sm" onClick={() => setShowProposeTask(true)}>Создать задачу</Button>}>
              <p className="ds-field-hint">Задача создаётся с явным исполнителем и сроком.</p>
            </Card>
          )}
        </>
      )}

      {tab === 'program' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <Button size="sm" variant="ghost" icon={Plane} onClick={() => setShowCreateLeg(true)}>
                Добавить перелёт
              </Button>
              <Button size="sm" variant="ghost" icon={CalendarIcon} onClick={() => setShowCreateEvent(true)}>
                Добавить событие
              </Button>
              <Button size="sm" variant="ghost" icon={Hotel} onClick={() => setShowCreateStay(true)}>
                Добавить проживание
              </Button>
            </div>
          )}
          {programItems.length === 0 ? <EmptyState title="Программа пока пуста" /> : programItems.map((i) => i.node)}
        </div>
      )}

      {tab === 'changes' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!changes || changes.length === 0 ? (
            <EmptyState title="Нет предложенных изменений" />
          ) : (
            changes.map((c) => <ChangeRow key={c.id} change={c} canApprove={canApprove} onResolved={() => { loadChanges(); loadTrip(); loadRevisions(); }} />)
          )}
        </div>
      )}

      {tab === 'people' && (
        <>
          <Card title="Участники (доступ)" actions={canManageAccess ? <Button size="sm" icon={UsersIcon} onClick={() => setShowAddMember(true)}>Добавить</Button> : undefined}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {trip.members.map((m) => (
                <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{m.employeeId}</span>
                  <Badge tone="info">{ACCESS_ROLE_LABELS[m.accessRole]}</Badge>
                </div>
              ))}
            </div>
          </Card>
          <Card
            title="Контакты поездки"
            style={{ marginTop: 16 }}
            actions={canEdit ? <Button size="sm" icon={Plus} onClick={() => setShowCreateContact(true)}>Добавить контакт</Button> : undefined}
          >
            {trip.contacts.length === 0 ? (
              <EmptyState title="Контактов пока нет" description="Появятся из материалов или добавятся вручную позже." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {trip.contacts.map((c) => (
                  <div key={c.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <strong>{c.name}</strong>
                      <Badge tone="outline">{CONTACT_ROLE_LABELS[c.role]}</Badge>
                    </div>
                    <p className="ds-field-hint" style={{ margin: '2px 0 0' }}>
                      {[c.organization, c.phone, c.email].filter(Boolean).join(' · ') || 'Нет дополнительных данных'}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {tab === 'history' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!revisions || revisions.length === 0 ? (
            <EmptyState icon={HistoryIcon} title="История пуста" />
          ) : (
            revisions.map((r) => (
              <Card key={r.id} tone="sunken">
                <p style={{ margin: 0 }}>{r.summary}</p>
                <p className="ds-field-hint" style={{ margin: '4px 0 0' }}>{fmtDateTime(r.appliedAt)}</p>
              </Card>
            ))
          )}
        </div>
      )}

      {showAddMaterials && <AddMaterialsDialog tripId={tripId} onClose={() => setShowAddMaterials(false)} onDone={() => { setShowAddMaterials(false); loadTrip(); loadChanges(); }} />}
      {showAddMember && <AddMemberDialog tripId={tripId} onClose={() => setShowAddMember(false)} onDone={() => { setShowAddMember(false); loadTrip(); }} />}
      {showProposeTask && <ProposeTaskDialog tripId={tripId} onClose={() => setShowProposeTask(false)} onDone={() => { setShowProposeTask(false); loadRevisions(); }} />}
      {showCreateLeg && <CreateLegDialog tripId={tripId} onClose={() => setShowCreateLeg(false)} onDone={() => { setShowCreateLeg(false); loadTrip(); }} />}
      {showCreateEvent && <CreateEventDialog tripId={tripId} onClose={() => setShowCreateEvent(false)} onDone={() => { setShowCreateEvent(false); loadTrip(); }} />}
      {showCreateStay && <CreateStayDialog tripId={tripId} onClose={() => setShowCreateStay(false)} onDone={() => { setShowCreateStay(false); loadTrip(); }} />}
      {showCreateContact && <CreateContactDialog tripId={tripId} onClose={() => setShowCreateContact(false)} onDone={() => { setShowCreateContact(false); loadTrip(); }} />}
    </>
  );
}

export default function TripDetailPage() {
  const params = useParams<{ id: string }>();
  return (
    <Protected>
      <TripDetailView tripId={params.id} />
    </Protected>
  );
}

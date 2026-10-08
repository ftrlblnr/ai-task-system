'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Clock, MapPin, Phone } from 'lucide-react';
import type { ProposedChangeItem, TripDetail, TripRevisionItem } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/telegram';
import { OverlayPortal } from './overlay-portal';
import { IconButton, Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Card } from '@/components/ui/card';

type Tab = 'now' | 'program' | 'changes' | 'history';

const BOOKING_LABELS: Record<string, string> = { BOOKED: 'Забронировано', PROPOSED: 'Предложено', UNCONFIRMED: 'Подтверждения не найдено' };
const BOOKING_TONE: Record<string, BadgeTone> = { BOOKED: 'ok', PROPOSED: 'info', UNCONFIRMED: 'warn' };
const LEG_MODE_LABELS: Record<string, string> = { FLIGHT: 'Перелёт', TRAIN: 'Поезд', CAR: 'Автомобиль', OTHER: 'Переезд' };

function fmtDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

interface NextThing {
  kind: 'leg' | 'event' | 'stay';
  title: string;
  at: string;
  location: string | null;
  contact: string | null;
}

// Раздел 11 ТЗ — режим "В дороге": следующее событие, локальное время,
// адрес, контакт. Без тикетов/статуса рейса в реальном времени (раздел 5
// ТЗ — "информация по билету, не живой статус рейса").
function computeNextThing(trip: TripDetail): NextThing | null {
  const now = Date.now();
  const candidates: NextThing[] = [];
  for (const leg of trip.legs) {
    if (leg.departAt && new Date(leg.departAt).getTime() > now) {
      candidates.push({ kind: 'leg', title: `${LEG_MODE_LABELS[leg.mode]}: ${leg.fromLocation ?? '?'} → ${leg.toLocation ?? '?'}`, at: leg.departAt, location: leg.fromLocation, contact: leg.carrier });
    }
  }
  for (const event of trip.events) {
    if (event.startAt && new Date(event.startAt).getTime() > now) {
      candidates.push({ kind: 'event', title: event.title, at: event.startAt, location: event.location, contact: null });
    }
  }
  for (const stay of trip.stays) {
    if (stay.checkInAt && new Date(stay.checkInAt).getTime() > now) {
      candidates.push({ kind: 'stay', title: stay.name ?? 'Проживание', at: stay.checkInAt, location: stay.address, contact: null });
    }
  }
  candidates.sort((a, b) => a.at.localeCompare(b.at));
  return candidates[0] ?? null;
}

export function TripDetailOverlay({ tripId, onClose, onChanged }: { tripId: string; onClose: () => void; onChanged: () => void }) {
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [changes, setChanges] = useState<ProposedChangeItem[] | null>(null);
  const [revisions, setRevisions] = useState<TripRevisionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('now');
  const [busyChangeId, setBusyChangeId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<TripDetail>(`/trips/${tripId}`)
      .then((t) => {
        setTrip(t);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить поездку'));
    api.get<ProposedChangeItem[]>(`/trips/${tripId}/changes`).then(setChanges).catch(() => undefined);
    api.get<TripRevisionItem[]>(`/trips/${tripId}/revisions`).then(setRevisions).catch(() => undefined);
  }, [tripId]);

  useEffect(load, [load]);

  async function resolveChange(changeId: string, action: 'approve' | 'reject') {
    setBusyChangeId(changeId);
    try {
      await api.post(`/trips/${tripId}/changes/${changeId}/${action}`);
      haptic('medium');
      load();
      onChanged();
    } catch {
      setError('Не удалось применить решение');
    } finally {
      setBusyChangeId(null);
    }
  }

  const pendingChanges = (changes ?? []).filter((c) => c.status === 'PENDING');
  const nextThing = trip ? computeNextThing(trip) : null;

  return (
    <OverlayPortal>
      <div className="overlay">
        <div className="overlay-header">
          <IconButton icon={ArrowLeft} label="Назад" variant="ghost" onClick={onClose} />
          <strong style={{ flex: 1 }}>{trip?.title ?? 'Поездка'}</strong>
        </div>
        <div className="overlay-body">
          {error && <Alert tone="danger">{error}</Alert>}
          {!trip && !error && <p className="ds-field-hint">Загрузка…</p>}
          {trip && (
            <>
              <div style={{ margin: '0 0 12px' }}>
                <Badge tone="outline">{trip.humanCode}</Badge>
                {trip.purposeSummary && <p style={{ margin: '6px 0 0' }}>{trip.purposeSummary}</p>}
              </div>

              <div style={{ margin: '0 0 12px' }}>
                <SegmentedControl
                  options={[
                    { value: 'now', label: 'Сейчас' },
                    { value: 'program', label: 'Программа' },
                    { value: 'changes', label: `Изменения${pendingChanges.length > 0 ? ` (${pendingChanges.length})` : ''}` },
                    { value: 'history', label: 'История' },
                  ]}
                  value={tab}
                  onChange={(v) => setTab(v as Tab)}
                />
              </div>

              {tab === 'now' && (
                <>
                  {nextThing ? (
                    <Card title="Ближайшее" tone="agent">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Clock size={14} strokeWidth={1.75} />
                        <strong>{fmtDateTime(nextThing.at)}</strong>
                      </div>
                      <p style={{ margin: '6px 0 0' }}>{nextThing.title}</p>
                      {nextThing.location && (
                        <p className="ds-field-hint" style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <MapPin size={14} strokeWidth={1.75} /> {nextThing.location}
                        </p>
                      )}
                      {nextThing.contact && (
                        <p className="ds-field-hint" style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Phone size={14} strokeWidth={1.75} /> {nextThing.contact}
                        </p>
                      )}
                    </Card>
                  ) : (
                    <EmptyState title="Нет предстоящих событий с подтверждённым временем" />
                  )}
                  {trip.contacts.length > 0 && (
                    <Card title="Контакты" style={{ marginTop: 12 }}>
                      {trip.contacts.map((c) => (
                        <div key={c.id} style={{ marginBottom: 6 }}>
                          <strong>{c.name}</strong>
                          {c.phone && <span className="ds-field-hint"> · {c.phone}</span>}
                        </div>
                      ))}
                    </Card>
                  )}
                </>
              )}

              {tab === 'program' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {trip.legs.length === 0 && trip.events.length === 0 && trip.stays.length === 0 && <EmptyState title="Программа пока пуста" />}
                  {trip.legs.map((leg) => (
                    <div key={leg.id} className="task-card" style={{ display: 'block' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span>
                          {LEG_MODE_LABELS[leg.mode]}: {leg.fromLocation ?? '?'} → {leg.toLocation ?? '?'}
                        </span>
                        <Badge tone={BOOKING_TONE[leg.bookingStatus]}>{BOOKING_LABELS[leg.bookingStatus]}</Badge>
                      </div>
                      <div className="ds-field-hint">{leg.departAt ? fmtDateTime(leg.departAt) : 'Время не подтверждено'}</div>
                    </div>
                  ))}
                  {trip.events.map((event) => (
                    <div key={event.id} className="task-card" style={{ display: 'block' }}>
                      <div>{event.title}</div>
                      <div className="ds-field-hint">
                        {event.startAt ? fmtDateTime(event.startAt) : event.dateOnly ? `${event.dateOnly.slice(0, 10)} · время не подтверждено` : 'Дата не подтверждена'}
                        {event.location ? ` · ${event.location}` : ''}
                      </div>
                    </div>
                  ))}
                  {trip.stays.map((stay) => (
                    <div key={stay.id} className="task-card" style={{ display: 'block' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span>{stay.name ?? 'Проживание'}</span>
                        <Badge tone={BOOKING_TONE[stay.bookingStatus]}>{BOOKING_LABELS[stay.bookingStatus]}</Badge>
                      </div>
                      <div className="ds-field-hint">{stay.address ?? 'Адрес не указан'}</div>
                    </div>
                  ))}
                </div>
              )}

              {tab === 'changes' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {!changes || changes.length === 0 ? (
                    <EmptyState title="Нет предложенных изменений" />
                  ) : (
                    changes.map((c) => (
                      <div key={c.id} className="task-card" style={{ display: 'block' }}>
                        {c.reason && <div>{c.reason}</div>}
                        {c.status === 'PENDING' ? (
                          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                            <Button variant="secondary" size="sm" onClick={() => resolveChange(c.id, 'reject')} disabled={busyChangeId === c.id}>
                              Отклонить
                            </Button>
                            <Button variant="primary" size="sm" onClick={() => resolveChange(c.id, 'approve')} disabled={busyChangeId === c.id}>
                              Подтвердить
                            </Button>
                          </div>
                        ) : (
                          <Badge tone={c.status === 'APPLIED' ? 'ok' : 'neutral'}>{c.status === 'APPLIED' ? 'Применено' : 'Отклонено'}</Badge>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}

              {tab === 'history' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {!revisions || revisions.length === 0 ? (
                    <EmptyState title="История пуста" />
                  ) : (
                    revisions.map((r) => (
                      <div key={r.id} className="task-card" style={{ display: 'block' }}>
                        <div>{r.summary}</div>
                        <div className="ds-field-hint">{fmtDateTime(r.appliedAt)}</div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </OverlayPortal>
  );
}

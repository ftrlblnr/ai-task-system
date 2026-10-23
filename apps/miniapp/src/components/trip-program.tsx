'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MapPin } from 'lucide-react';
import type { TripDetail } from '@ai-task-system/shared-types';
import {
  buildTripTimeline,
  dayOffset,
  describeEntryTime,
  formatDayKey,
  formatUntil,
  formatZoneTime,
  groupTimelineByDay,
  locateNow,
  zoneDayKey,
  zoneLabel,
  zoneShortName,
  type TimelineEntry,
} from '@ai-task-system/shared-types';

// Программа поездки (владелец 23.10.2026): по дням, время — по месту
// проведения (Казахстан/Пекин), при открытии — прокрутка к тому, что идёт
// сейчас, с отметкой «Вы сейчас здесь» и подсказкой, что дальше.

export type TripProgramEntry = TimelineEntry<TripDetail['legs'][number], TripDetail['events'][number], TripDetail['stays'][number]>;

const TICK_MS = 60_000;

export function TripProgram({ trip, entryTitle, renderEntry }: { trip: TripDetail; entryTitle: (e: TripProgramEntry) => string; renderEntry: (e: TripProgramEntry, when: string) => ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  const anchor = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const entries = useMemo(() => buildTripTimeline(trip), [trip]);
  const days = useMemo(() => groupTimelineByDay(entries), [entries]);
  const position = locateNow(entries, now);
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const current = position?.currentKey ? byKey.get(position.currentKey) : undefined;
  const next = position?.nextKey ? byKey.get(position.nextKey) : undefined;
  const anchorKey = position ? (position.between ? position.nextKey : position.currentKey) : null;
  const todayKey = position ? zoneDayKey(now, position.offset) : null;

  // Один раз при открытии — к текущему пункту.
  useEffect(() => {
    if (scrolled.current || !anchor.current) return;
    scrolled.current = true;
    anchor.current.scrollIntoView({ block: 'center' });
  }, [anchorKey]);

  function scrollToNow() {
    anchor.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  return (
    <div className="trip-program">
      {position && (
        <button type="button" className="trip-now-summary" onClick={scrollToNow}>
          <span className="trip-now-clock">
            <MapPin size={14} strokeWidth={1.75} /> Сейчас {formatZoneTime(now, position.offset)} · {zoneShortName(position.offset)}
          </span>
          <span>
            {current && !position.between ? <strong>{entryTitle(current)}</strong> : current ? `${entryTitle(current)} · свободное время` : 'Свободное время'}
          </span>
          {next?.start != null && (
            <span className="ds-field-hint">
              Далее: {entryTitle(next)} в {formatZoneTime(next.start, next.offset)}
              {next.offset !== position.offset ? ` (${zoneShortName(next.offset)})` : ''}, {formatUntil(now, next.start)}
            </span>
          )}
        </button>
      )}

      {days.map((day) => {
        const base = dayOffset(day);
        return (
          <section key={day.dayKey ?? 'undated'} className="trip-day">
            <h3 className="trip-day-title">
              {day.dayKey ? formatDayKey(day.dayKey) : 'Без даты'}
              {day.dayKey === todayKey && <span className="trip-day-today">сегодня</span>}
              {day.dayKey && <span className="ds-field-hint">{zoneLabel(base)}</span>}
            </h3>
            {day.entries.map((e) => {
              const isAnchor = e.key === anchorKey;
              const isCurrent = position && !position.between && e.key === position.currentKey;
              const isNext = e.key === position?.nextKey;
              return (
                <div key={e.key} ref={isAnchor ? anchor : undefined} className={isCurrent ? 'trip-entry is-now' : 'trip-entry'}>
                  {position?.between && isNext && (
                    <div className="trip-now-line">
                      <span>
                        Вы сейчас здесь · {formatZoneTime(now, position.offset)}, {zoneShortName(position.offset)}
                      </span>
                    </div>
                  )}
                  {isCurrent && <div className="trip-now-badge">Вы сейчас здесь</div>}
                  {isNext && e.start !== null && <div className="trip-next-badge">Далее · {formatUntil(now, e.start)}</div>}
                  {renderEntry(e, describeEntryTime(e, base))}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

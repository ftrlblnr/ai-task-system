'use client';

import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { ChevronLeft, ChevronRight, MapPin, Trash2, Users } from 'lucide-react';
import type { CalendarEvent } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import {
  addDays,
  companyDayKey,
  companyDayStart,
  companyTime,
  dayOfMonth,
  minutesFromDayStart,
  monthLabel,
  weekdayIndex,
  weekStartKey,
} from '@/lib/company-time';
import { haptic, notificationHaptic } from '@/lib/telegram';
import { Alert, Button, Dialog, IconButton, ScreenHeader, cx } from '@/components/ui';
import { OverlayPortal } from './overlay-portal';

// «Календарь» (редизайн M3, MINIAPP_REDESIGN.md §4.4): полоса недели и лента
// выбранного дня. Неделя грузится одним GET /events?from&to; дни и часы —
// по времени компании (Asia/Almaty), как «Сегодня» и сервер.

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const HOUR_PX = 52;
const DAY_FROM = 8;
const DAY_TO = 20;
const SWIPE_PX = 50;

// Форма слова «событие» для надзаголовка.
function eventsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'событие';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'события';
  return 'событий';
}

// Пересекается ли событие с днём компании.
function onDay(ev: CalendarEvent, key: string): boolean {
  return minutesFromDayStart(ev.startAt, key) < 24 * 60 && minutesFromDayStart(ev.endAt, key) > 0;
}

interface Placed {
  event: CalendarEvent;
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

// Раскладка пересекающихся событий по колонкам: группа пересечений делит
// ширину поровну, событие встаёт в первую свободную колонку.
function layout(events: CalendarEvent[], key: string, fromHour: number): Placed[] {
  const items = events
    .map((event) => ({
      event,
      start: Math.max(0, minutesFromDayStart(event.startAt, key)),
      end: Math.min(24 * 60, minutesFromDayStart(event.endAt, key)),
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const placed: Placed[] = [];
  let group: { item: (typeof items)[number]; lane: number }[] = [];
  let groupEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...group.map((g) => g.lane + 1));
    for (const { item, lane } of group) {
      placed.push({
        event: item.event,
        top: ((item.start - fromHour * 60) / 60) * HOUR_PX,
        // Короткое событие всё равно должно читаться и нажиматься.
        height: Math.max(((item.end - item.start) / 60) * HOUR_PX, 26),
        lane,
        lanes,
      });
    }
    group = [];
  };
  for (const item of items) {
    if (group.length > 0 && item.start >= groupEnd) flush();
    const laneEnds: number[] = [];
    for (const g of group) {
      const end = Math.min(24 * 60, minutesFromDayStart(g.item.event.endAt, key));
      laneEnds[g.lane] = Math.max(laneEnds[g.lane] ?? -1, end);
    }
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) lane = laneEnds.length;
    group.push({ item, lane });
    groupEnd = Math.max(groupEnd, item.end);
  }
  if (group.length > 0) flush();
  return placed;
}

export function CalendarScreen({ active = true }: { active?: boolean }) {
  const [todayKey, setTodayKey] = useState(() => companyDayKey(new Date()));
  const [selected, setSelected] = useState(todayKey);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openEvent, setOpenEvent] = useState<CalendarEvent | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const touchX = useRef<number | null>(null);
  const requestRef = useRef(0);

  const weekStart = weekStartKey(selected);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  function load() {
    const requestId = ++requestRef.current;
    const params = new URLSearchParams({
      from: companyDayStart(weekStart).toISOString(),
      to: companyDayStart(addDays(weekStart, 7)).toISOString(),
    });
    api
      .get<CalendarEvent[]>(`/events?${params.toString()}`)
      .then((list) => {
        if (requestId !== requestRef.current) return;
        setEvents(list.filter((e) => e.status !== 'CANCELLED'));
        setError(null);
      })
      .catch(() => {
        if (requestId === requestRef.current) setError('Не удалось загрузить календарь');
      });
  }

  // active — рефетч при возвращении на вкладку (см. tasks-screen.tsx);
  // заодно обновляем «сегодня», если Mini App висел открытым через полночь.
  useEffect(() => {
    if (!active) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- часы — внешний источник
    setTodayKey(companyDayKey(new Date()));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load зависит только от недели
  }, [active, weekStart]);

  // Линия «сейчас» — раз в минуту, только пока раздел открыт.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [active]);

  function shiftWeek(weeks: number) {
    haptic('light');
    setEvents(null);
    setSelected((s) => addDays(s, weeks * 7));
  }

  function onTouchStart(e: TouchEvent) {
    touchX.current = e.touches[0].clientX;
  }
  function onTouchEnd(e: TouchEvent) {
    if (touchX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchX.current;
    touchX.current = null;
    if (Math.abs(dx) >= SWIPE_PX) shiftWeek(dx < 0 ? 1 : -1);
  }

  async function removeEvent(ev: CalendarEvent) {
    if (!window.confirm(`Удалить событие «${ev.title}»? Это действие необратимо.`)) return;
    try {
      await api.delete(`/events/${ev.id}`);
      notificationHaptic('success');
      setOpenEvent(null);
      load();
    } catch (err) {
      notificationHaptic('error');
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить событие');
    }
  }

  const weekEvents = events ?? [];
  const dayEvents = weekEvents.filter((e) => onDay(e, selected));
  const allDay = dayEvents.filter((e) => e.allDay);
  const timed = dayEvents.filter((e) => !e.allDay);

  // Часы ленты: 08–20, шире — если событие выходит за границы.
  let fromHour = DAY_FROM;
  let toHour = DAY_TO;
  for (const e of timed) {
    fromHour = Math.min(fromHour, Math.floor(Math.max(0, minutesFromDayStart(e.startAt, selected)) / 60));
    toHour = Math.max(toHour, Math.ceil(Math.min(24 * 60, minutesFromDayStart(e.endAt, selected)) / 60));
  }
  const hours = Array.from({ length: toHour - fromHour }, (_, i) => fromHour + i);
  const placed = layout(timed, selected, fromHour);

  const nowMinutes = minutesFromDayStart(new Date(now), selected);
  const showNow = selected === todayKey && nowMinutes >= fromHour * 60 && nowMinutes <= toHour * 60;

  return (
    <div>
      <ScreenHeader
        kicker={events ? `${monthLabel(selected)} · ${weekEvents.length} ${eventsWord(weekEvents.length)}` : monthLabel(selected)}
        title="Календарь"
        action={
          selected !== todayKey ? (
            <Button variant="secondary" size="sm" onClick={() => setSelected(todayKey)}>
              Сегодня
            </Button>
          ) : undefined
        }
      />

      <div className="week-nav">
        <IconButton icon={ChevronLeft} label="Предыдущая неделя" variant="ghost" onClick={() => shiftWeek(-1)} />
        <div className="week-strip" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {days.map((key) => {
            const has = weekEvents.some((e) => onDay(e, key));
            return (
              <button
                key={key}
                type="button"
                className={cx(
                  'week-day',
                  key === selected && 'is-selected',
                  key === todayKey && 'is-today',
                  weekdayIndex(key) >= 5 && 'is-weekend',
                )}
                aria-pressed={key === selected}
                aria-label={`${WEEKDAYS[weekdayIndex(key)]}, ${dayOfMonth(key)}${has ? ', есть события' : ''}`}
                onClick={() => setSelected(key)}
              >
                <span className="week-day-name">{WEEKDAYS[weekdayIndex(key)]}</span>
                <span className="week-day-num">{dayOfMonth(key)}</span>
                <span className={cx('week-day-dot', has && 'is-on')} />
              </button>
            );
          })}
        </div>
        <IconButton icon={ChevronRight} label="Следующая неделя" variant="ghost" onClick={() => shiftWeek(1)} />
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {allDay.length > 0 && (
        <div className="allday-list">
          {allDay.map((ev) => (
            <button key={ev.id} type="button" className={cx('allday-event', ev.status === 'DRAFT' && 'is-draft')} onClick={() => setOpenEvent(ev)}>
              <span className="due">весь день</span>
              {ev.title}
            </button>
          ))}
        </div>
      )}

      <div className="day-timeline" style={{ height: hours.length * HOUR_PX }}>
        {hours.map((h, i) => (
          <div key={h} className="timeline-hour" style={{ top: i * HOUR_PX }}>
            <span className="timeline-hour-label">{String(h).padStart(2, '0')}:00</span>
          </div>
        ))}
        <div className="timeline-events">
          {placed.map(({ event, top, height, lane, lanes }) => (
            <button
              key={event.id}
              type="button"
              className={cx('timeline-event', event.status === 'DRAFT' && 'is-draft', height < 44 && 'is-short')}
              style={{ top, height, left: `${(lane / lanes) * 100}%`, width: `calc(${100 / lanes}% - 4px)` }}
              onClick={() => setOpenEvent(event)}
            >
              <span className="timeline-event-title">{event.title}</span>
              <span className="timeline-event-meta">
                {companyTime(event.startAt)}–{companyTime(event.endAt)}
                {event.location ? ` · ${event.location}` : ''}
              </span>
            </button>
          ))}
          {showNow && <div className="timeline-now" style={{ top: ((nowMinutes - fromHour * 60) / 60) * HOUR_PX }} aria-hidden="true" />}
        </div>
      </div>

      {openEvent && (
        <OverlayPortal>
          <Dialog
            sheet
            title={openEvent.title}
            description={
              openEvent.allDay
                ? 'Весь день'
                : `${companyDayKey(openEvent.startAt) === todayKey ? 'Сегодня' : new Date(openEvent.startAt).toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'long' })}, ${companyTime(openEvent.startAt)}–${companyTime(openEvent.endAt)}${openEvent.status === 'DRAFT' ? ' · черновик' : ''}`
            }
            onClose={() => setOpenEvent(null)}
            footer={
              // /events закрыт на руководителей (CalendarController), а этот
              // раздел и так виден только им (page.tsx).
              <Button variant="danger" icon={Trash2} onClick={() => void removeEvent(openEvent)}>
                Удалить событие
              </Button>
            }
          >
            <div className="event-sheet">
              {openEvent.location && (
                <p className="event-sheet-row">
                  <MapPin size={16} strokeWidth={1.75} />
                  {openEvent.location}
                </p>
              )}
              {openEvent.participants.length > 0 && (
                <p className="event-sheet-row">
                  <Users size={16} strokeWidth={1.75} />
                  {openEvent.participants.map((p) => p.fullName).join(', ')}
                </p>
              )}
              {openEvent.description && <p className="event-sheet-desc">{openEvent.description}</p>}
            </div>
          </Dialog>
        </OverlayPortal>
      )}
    </div>
  );
}

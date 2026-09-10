'use client';

import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { CalendarEvent } from '@ai-task-system/shared-types';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/telegram';

export function CalendarScreen({ active = true }: { active?: boolean }) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .get<CalendarEvent[]>('/events')
      .then(setEvents)
      .catch(() => setError('Не удалось загрузить календарь'));
  }

  // active — см. комментарий в tasks-screen.tsx: рефетч при возвращении на
  // вкладку, не только при первом монтировании Mini App.
  useEffect(() => {
    if (active) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // /events закрыт на Role.OWNER на бэкенде (CalendarController) — этот
  // экран и так открыт только руководителю (см. page.tsx), поэтому
  // отдельной проверки роли здесь не нужно.
  async function removeEvent(ev: CalendarEvent) {
    if (!window.confirm(`Удалить событие «${ev.title}»? Это действие необратимо.`)) return;
    haptic('medium');
    try {
      await api.delete(`/events/${ev.id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось удалить событие');
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!events) return <p className="hint">Загрузка…</p>;

  if (events.length === 0) {
    return (
      <div className="empty-state">
        <strong>Событий пока нет</strong>
      </div>
    );
  }

  const byDay = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = new Date(ev.startAt).toLocaleDateString('ru-RU', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
    });
    byDay.set(key, [...(byDay.get(key) ?? []), ev]);
  }

  return (
    <div>
      <h1 style={{ margin: '10px 0 4px' }}>Календарь</h1>
      {[...byDay.entries()].map(([day, dayEvents]) => (
        <div key={day} className="day-group">
          <div className="day-group-title">{day}</div>
          {dayEvents.map((ev) => (
            <div key={ev.id} className="event-card">
              <div className="event-time">
                {ev.allDay
                  ? 'весь\nдень'
                  : new Date(ev.startAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
              </div>
              <div style={{ flex: 1 }}>
                <div className="event-title">{ev.title}</div>
                {ev.location && <div className="hint">{ev.location}</div>}
              </div>
              <button
                onClick={() => removeEvent(ev)}
                aria-label="Удалить событие"
                style={{ color: 'var(--danger)', flex: 'none', padding: 4 }}
              >
                <Trash2 size={15} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

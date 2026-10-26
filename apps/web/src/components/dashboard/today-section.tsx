'use client';

import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import type { DashboardCalendarSection, DashboardEventItem } from '@ai-task-system/shared-types';
import { Alert, Button, Panel, Skeleton, cx } from '@/components/ui';
import { useAgentPanel } from '@/components/agent-panel/agent-context';
import type { SectionState } from './use-dashboard-overview';
import { span, time } from './format';

// «Сегодня» (редизайн web W5, §4.3): ближайшее событие крупно с кнопкой
// «Подготовиться» (вопрос агенту в панели), ниже — весь день: прошедшие
// зачёркнуты, следующее — акцентом.

const PEOPLE_SHOWN = 2;

function people(ev: DashboardEventItem): string | null {
  const names = ev.participants.map((p) => p.fullName);
  if (names.length === 0) return null;
  const shown = names.slice(0, PEOPLE_SHOWN).join(', ');
  return names.length > PEOPLE_SHOWN ? `${shown} и ещё ${names.length - PEOPLE_SHOWN}` : shown;
}

function nextLabel(ev: DashboardEventItem, now: number): string {
  const start = new Date(ev.startAt).getTime();
  const when = start <= now ? `Идёт · до ${time(ev.endAt)}` : `Через ${span(now, start)} · ${time(ev.startAt)}`;
  return ev.location ? `${when} · ${ev.location}` : when;
}

export function TodaySection({ state, loading, now }: { state: SectionState<DashboardCalendarSection>; loading: boolean; now: number }) {
  const { ask } = useAgentPanel();
  const events = state.data?.today ?? [];
  // Следующее — первое ещё не закончившееся событие со временем.
  const next = events.find((e) => !e.allDay && new Date(e.endAt).getTime() > now) ?? null;

  return (
    <Panel icon={CalendarDays} title="Сегодня" href="/calendar" hrefLabel="Календарь">
      {!state.data ? (
        state.error ? (
          <Alert tone="danger">{state.error}</Alert>
        ) : loading ? (
          <Skeleton height={96} />
        ) : null
      ) : (
        <>
          {next && (
            <div className="pult-next">
              <span className="pult-next-when">{nextLabel(next, now)}</span>
              <Link href={`/calendar?event=${next.id}`} className="pult-next-title">
                {next.title}
              </Link>
              <div className="pult-next-foot">
                <span className="pult-next-people">{people(next)}</span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => ask(`Подготовь меня к встрече «${next.title}» в ${time(next.startAt)}`, { kind: 'event', id: next.id, label: next.title })}
                >
                  Подготовиться
                </Button>
              </div>
            </div>
          )}
          {events.length === 0 ? (
            <p className="console-empty">Сегодня встреч нет</p>
          ) : (
            <ul className="pult-agenda">
              {events.map((ev) => {
                const past = !ev.allDay && new Date(ev.endAt).getTime() <= now;
                const isNext = ev.id === next?.id;
                return (
                  <li key={ev.id} className={cx('pult-agenda-row', past && 'is-past', isNext && 'is-next')}>
                    <span className="pult-agenda-time ds-num">{ev.allDay ? 'день' : time(ev.startAt)}</span>
                    <span className="pult-agenda-dot" aria-hidden="true" />
                    <Link href={`/calendar?event=${ev.id}`} className="pult-agenda-title">
                      {ev.title}
                    </Link>
                    {ev.location && <span className="pult-agenda-place">{ev.location}</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

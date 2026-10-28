import type Anthropic from '@anthropic-ai/sdk';
import { withLocalOffset } from '../common/timezone';
import type { EventCardData } from './dto/message-part-data.dto';
import { formatDue, type TaskChange } from './task-tools';

// Единый агент A3 (docs/AGENT_AND_MEETINGS.md): календарь в чате. Здесь —
// схемы инструментов, разбор входа модели и «было → стало»; исполнитель —
// AssistantToolsService. Инструменты выдаются только руководству: календарь
// личный (CalendarController закрыт на MANAGER_ROLES), владелец данных —
// сам пользователь.

export const FIND_EVENTS_DEFAULT_DAYS = 7;
export const FIND_EVENTS_MAX = 20;
export const FREE_SLOTS_DEFAULT_DAYS = 7;
export const FREE_SLOTS_MAX = 10;
// Одно событие не длиннее суток (кроме «весь день») — защита от ошибки
// модели вроде конца встречи через месяц.
const MAX_EVENT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EVENT_MINUTES = 60;

const TIME_HINT = 'местное время без смещения, «2026-11-02T15:00:00»';
const EVENT_ID_PROP = {
  eventId: {
    type: 'string',
    description:
      'id события из find_events/get_events, [shown_event] или [page_context]',
  },
} as const;
const WRITE_RULES =
  'Только по прямой просьбе. id события — только из find_events/get_events, пометки [shown_event] или блока [page_context]; если неясно, о какой встрече речь, найди через find_events и переспроси при нескольких кандидатах. Участников передавай именами, как прозвучали, — сервер сам найдёт сотрудников и переспросит, если имя неоднозначно. Выполняется сразу; у пользователя 30 секунд, чтобы отменить кнопкой на карточке.';

export const FIND_EVENTS_TOOL: Anthropic.Tool = {
  name: 'find_events',
  description: `Найти события в календаре за период (по умолчанию — с начала сегодняшнего дня на ${FIND_EVENTS_DEFAULT_DAYS} дней вперёд): «что у меня завтра», «встречи на следующей неделе», «когда встреча с Арманом», «что было в понедельник». Можно сузить по слову в названии/месте/описании и по участнику. Отменённые не показываются. Только чтобы узнать, ЧТО запланировано, — для «найди время/час/окно», «когда я свободен» сразу вызывай find_free_slots.`,
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: `Начало периода — ${TIME_HINT}` },
      to: { type: 'string', description: `Конец периода — ${TIME_HINT}` },
      query: {
        type: 'string',
        description: 'Слово из названия, места или описания',
      },
      participantRawText: {
        type: 'string',
        description: 'Участник, как назван',
      },
    },
    required: [],
  },
};

export const FIND_FREE_SLOTS_TOOL: Anthropic.Tool = {
  name: 'find_free_slots',
  description: `Найти свободное время в календаре пользователя под встречу заданной длины — с учётом рабочих часов, буферов между встречами и минимального срока записи (настройки календаря). По умолчанию ищет с текущего момента на ${FREE_SLOTS_DEFAULT_DAYS} дней вперёд. Вызывай сразу, без предварительного find_events, когда просят «найди время/час/окно», «когда я свободен», «поставь на ближайшее свободное», в том числе «найди час с Арманом» — встречу с сотрудником ставят в свободное время пользователя. Занятость других сотрудников не проверяется — только календарь пользователя; googleChecked=false — Google Календарь в этот раз не проверен, скажи об этом.`,
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: `Искать не раньше — ${TIME_HINT}` },
      to: { type: 'string', description: `Искать не позже — ${TIME_HINT}` },
      durationMinutes: {
        type: 'integer',
        description: `Длина встречи в минутах, по умолчанию ${DEFAULT_EVENT_MINUTES}`,
      },
      maxResults: {
        type: 'integer',
        description: `Сколько вариантов, 1–${FREE_SLOTS_MAX}, по умолчанию 3`,
      },
    },
    required: [],
  },
};

export const CREATE_EVENT_TOOL: Anthropic.Tool = {
  name: 'create_event',
  description: `Поставить новое событие (встречу, звонок, напоминание на время) в календарь пользователя. Конец не назван — длительность ${DEFAULT_EVENT_MINUTES} минут или durationMinutes. ${WRITE_RULES}`,
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      startAt: { type: 'string', description: `Начало — ${TIME_HINT}` },
      endAt: { type: 'string', description: `Конец — ${TIME_HINT}` },
      durationMinutes: { type: 'integer' },
      allDay: { type: 'boolean', description: 'Событие на весь день' },
      location: { type: 'string' },
      description: { type: 'string' },
      participants: {
        type: 'array',
        items: { type: 'string' },
        description: 'Сотрудники-участники, как названы',
      },
    },
    required: ['title', 'startAt'],
  },
};

export const UPDATE_EVENT_TOOL: Anthropic.Tool = {
  name: 'update_event',
  description: `Изменить событие: перенести (новое начало — длительность сохраняется, если конец не назван), переименовать, сменить место или описание, добавить или убрать участников. Передавай только то, что просят изменить. ${WRITE_RULES}`,
  input_schema: {
    type: 'object',
    properties: {
      ...EVENT_ID_PROP,
      title: { type: 'string' },
      startAt: { type: 'string', description: `Новое начало — ${TIME_HINT}` },
      endAt: { type: 'string', description: `Новый конец — ${TIME_HINT}` },
      durationMinutes: { type: 'integer' },
      location: { type: 'string' },
      description: { type: 'string' },
      addParticipants: { type: 'array', items: { type: 'string' } },
      removeParticipants: { type: 'array', items: { type: 'string' } },
    },
    required: ['eventId'],
  },
};

export const DELETE_EVENT_TOOL: Anthropic.Tool = {
  name: 'delete_event',
  description:
    'Удалить событие из календаря (и из Google Календаря, если он подключён). Только на прямую просьбу «удали/отмени встречу». Отменить удаление нельзя. id — только из find_events/get_events, [shown_event] или [page_context].',
  input_schema: {
    type: 'object',
    properties: { ...EVENT_ID_PROP },
    required: ['eventId'],
  },
};

export const EVENT_READ_TOOLS: Anthropic.Tool[] = [
  FIND_EVENTS_TOOL,
  FIND_FREE_SLOTS_TOOL,
];
export const EVENT_WRITE_TOOLS: Anthropic.Tool[] = [
  CREATE_EVENT_TOOL,
  UPDATE_EVENT_TOOL,
  DELETE_EVENT_TOOL,
];

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// Время модели — местное без смещения (как у задач); непонятная строка —
// undefined, а не исключение.
export function localDate(v: unknown): Date | undefined {
  const raw = text(v);
  if (!raw) return undefined;
  const date = new Date(withLocalOffset(raw) as string);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function names(v: unknown): string[] {
  return Array.isArray(v)
    ? [...new Set(v.map(text).filter((s): s is string => !!s))]
    : [];
}

function minutes(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 5 ? Math.round(n) : undefined;
}

// Начало локального дня компании (00:00 по Алматы) для «с сегодняшнего дня».
export function localDayStart(now: Date): Date {
  return new Date(
    withLocalOffset(
      `${new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10)}T00:00:00`,
    ) as string,
  );
}

export interface FindEventsInput {
  from: Date;
  to: Date;
  query?: string;
  participantRawText?: string;
}

export function parseFindEventsInput(
  input: unknown,
  now: Date = new Date(),
): FindEventsInput {
  const typed = (input ?? {}) as Record<string, unknown>;
  const from = localDate(typed.from) ?? localDayStart(now);
  const to =
    localDate(typed.to) ??
    new Date(from.getTime() + FIND_EVENTS_DEFAULT_DAYS * 86400_000);
  return {
    from,
    to: to > from ? to : new Date(from.getTime() + 86400_000),
    query: text(typed.query),
    participantRawText: text(typed.participantRawText),
  };
}

export interface FreeSlotsInput {
  from: Date;
  to: Date;
  durationMinutes: number;
  maxResults: number;
}

export function parseFreeSlotsInput(
  input: unknown,
  now: Date = new Date(),
): FreeSlotsInput {
  const typed = (input ?? {}) as Record<string, unknown>;
  const from = localDate(typed.from) ?? now;
  const to =
    localDate(typed.to) ??
    new Date(from.getTime() + FREE_SLOTS_DEFAULT_DAYS * 86400_000);
  const max = Number(typed.maxResults);
  return {
    from,
    to: to > from ? to : new Date(from.getTime() + 86400_000),
    durationMinutes: minutes(typed.durationMinutes) ?? DEFAULT_EVENT_MINUTES,
    maxResults:
      Number.isFinite(max) && max >= 1
        ? Math.min(Math.floor(max), FREE_SLOTS_MAX)
        : 3,
  };
}

export interface CreateEventInput {
  title: string;
  startAt?: Date;
  endAt?: Date;
  allDay: boolean;
  location?: string;
  description?: string;
  participants: string[];
}

export function parseCreateEventInput(
  input: unknown,
): CreateEventInput | { error: string } {
  const typed = (input ?? {}) as Record<string, unknown>;
  const title = text(typed.title);
  const startAt = localDate(typed.startAt);
  if (!title || !startAt)
    return { error: 'INVALID_INPUT: нужны название и время начала' };
  const endAt =
    localDate(typed.endAt) ??
    new Date(
      startAt.getTime() +
        (minutes(typed.durationMinutes) ?? DEFAULT_EVENT_MINUTES) * 60_000,
    );
  const allDay = typed.allDay === true;
  if (endAt <= startAt)
    return { error: 'INVALID_INPUT: конец события раньше начала' };
  if (!allDay && endAt.getTime() - startAt.getTime() > MAX_EVENT_MS)
    return {
      error:
        'INVALID_INPUT: событие длиннее суток — уточни у пользователя время окончания',
    };
  return {
    title,
    startAt,
    endAt,
    allDay,
    location: text(typed.location),
    description: text(typed.description),
    participants: names(typed.participants),
  };
}

export interface UpdateEventInput {
  eventId: string;
  title?: string;
  startAt?: Date;
  endAt?: Date;
  durationMinutes?: number;
  location?: string;
  description?: string;
  addParticipants: string[];
  removeParticipants: string[];
}

export function parseUpdateEventInput(input: unknown): UpdateEventInput {
  const typed = (input ?? {}) as Record<string, unknown>;
  return {
    eventId: text(typed.eventId) ?? '',
    title: text(typed.title),
    startAt: localDate(typed.startAt),
    endAt: localDate(typed.endAt),
    durationMinutes: minutes(typed.durationMinutes),
    // Место и описание можно очистить пустой строкой.
    location:
      typeof typed.location === 'string' ? typed.location.trim() : undefined,
    description:
      typeof typed.description === 'string'
        ? typed.description.trim()
        : undefined,
    addParticipants: names(typed.addParticipants),
    removeParticipants: names(typed.removeParticipants),
  };
}

// Новое время события: перенос начала сохраняет длительность, если конец не
// назван; только длительность — от прежнего начала.
export function nextEventTimes(
  before: { startAt: Date; endAt: Date },
  input: { startAt?: Date; endAt?: Date; durationMinutes?: number },
): { startAt?: Date; endAt?: Date } | { error: string } {
  if (!input.startAt && !input.endAt && !input.durationMinutes) return {};
  const startAt = input.startAt ?? before.startAt;
  const endAt =
    input.endAt ??
    (input.durationMinutes
      ? new Date(startAt.getTime() + input.durationMinutes * 60_000)
      : new Date(
          startAt.getTime() +
            (before.endAt.getTime() - before.startAt.getTime()),
        ));
  if (endAt <= startAt)
    return { error: 'INVALID_INPUT: конец события раньше начала' };
  return {
    ...(startAt.getTime() !== before.startAt.getTime() ? { startAt } : {}),
    ...(endAt.getTime() !== before.endAt.getTime() ? { endAt } : {}),
  };
}

interface EventSnapshot {
  title: string;
  startAt: Date;
  endAt: Date;
  location: string | null;
  description: string | null;
  participants: { id: string; fullName: string }[];
}

export function describeEventChanges(
  before: EventSnapshot,
  after: EventSnapshot,
): TaskChange[] {
  const changes: TaskChange[] = [];
  const push = (label: string, from: string | null, to: string | null) => {
    if (from !== to) changes.push({ label, from, to });
  };
  push('Название', before.title, after.title);
  push('Начало', formatDue(before.startAt), formatDue(after.startAt));
  push('Окончание', formatDue(before.endAt), formatDue(after.endAt));
  push('Место', before.location || null, after.location || null);
  if ((before.description ?? '') !== (after.description ?? ''))
    changes.push({
      label: 'Описание',
      from: null,
      to: after.description ? 'изменено' : 'очищено',
    });
  const was = new Set(before.participants.map((p) => p.id));
  const now = new Set(after.participants.map((p) => p.id));
  const added = after.participants
    .filter((p) => !was.has(p.id))
    .map((p) => p.fullName);
  const removed = before.participants
    .filter((p) => !now.has(p.id))
    .map((p) => p.fullName);
  if (added.length)
    changes.push({ label: 'Добавлены', from: null, to: added.join(', ') });
  if (removed.length)
    changes.push({ label: 'Убраны', from: null, to: removed.join(', ') });
  return changes;
}

export function toEventCard(e: {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
  location: string | null;
  participants: { id: string; fullName: string }[];
}): EventCardData {
  return {
    eventId: e.id,
    title: e.title,
    startAt: e.startAt.toISOString(),
    endAt: e.endAt.toISOString(),
    location: e.location,
    participants: e.participants.map((p) => ({ id: p.id, name: p.fullName })),
  };
}

// Местное время компании без смещения — в том виде, в каком модель
// передаёт время обратно в create_event/update_event. UTC-строку модель
// приняла бы за местное время и сдвинула бы встречу на 5 часов.
export function localIso(date: Date): string {
  return new Date(date.getTime() + 5 * 3600_000).toISOString().slice(0, 19);
}

// Слот для модели: start/end — сразу годятся для create_event.
export function toSlotData(slot: { start: Date; end: Date }): {
  start: string;
  end: string;
} {
  return { start: localIso(slot.start), end: localIso(slot.end) };
}

// Событие для модели: время — местное, без смещения.
export interface FoundEventData {
  eventId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  participants: string[];
}

export function toFoundEvent(e: {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  location: string | null;
  participants: { fullName: string }[];
}): FoundEventData {
  return {
    eventId: e.id,
    title: e.title,
    start: localIso(e.startAt),
    end: localIso(e.endAt),
    allDay: e.allDay,
    location: e.location,
    participants: e.participants.map((p) => p.fullName),
  };
}

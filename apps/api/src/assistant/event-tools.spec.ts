import { ConflictException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CalendarAvailabilityService } from '../calendar/calendar-availability.service';
import { defaultAvailabilityPolicy } from '../calendar/calendar-availability';
import { AssistantToolsService, isWriteTool, toolResultForModel } from './assistant-tools.service';
import { buildAssistantParts } from './assistant-render';
import { describeEventChanges, localIso, nextEventTimes, parseCreateEventInput, parseFindEventsInput, toSlotData } from './event-tools';

// Единый агент A3 (docs/AGENT_AND_MEETINGS.md): календарь в чате — поиск,
// свободное время, создание/перенос/удаление с отменой и защитой от повторов.

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.OWNER, ...overrides };
}

const at = (iso: string) => new Date(iso);

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    title: 'Планёрка',
    description: null,
    location: 'Кабинет',
    startAt: at('2026-10-29T05:00:00Z'), // 10:00 по Алматы
    endAt: at('2026-10-29T06:00:00Z'),
    allDay: false,
    status: 'CONFIRMED',
    version: 3,
    participants: [{ id: 'p1', fullName: 'Ким Арман' }],
    ...overrides,
  };
}

function prismaStub() {
  let row: Record<string, unknown> | null = null;
  return {
    agentActionExecution: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        if (row) return Promise.reject(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6.19.3' }));
        row = { id: 'x1', status: 'CLAIMED', createdAt: new Date(), updatedAt: new Date(), ...data };
        return Promise.resolve(row);
      }),
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(row)),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        row = { ...row, ...data };
        return Promise.resolve(row);
      }),
    },
    undoRecord: { create: jest.fn().mockImplementation(({ data }: { data: { expiresAt: Date } }) => Promise.resolve({ id: 'undo-1', expiresAt: data.expiresAt })) },
    employee: { findMany: jest.fn().mockResolvedValue([{ id: 'p2', fullName: 'Иванова Ирина' }]) },
    event: { count: jest.fn(), findFirst: jest.fn() },
    get row() {
      return row;
    },
  };
}

function serviceWith(events: Record<string, jest.Mock>, availability?: Record<string, jest.Mock>) {
  const prisma = prismaStub();
  const resolver = { resolve: jest.fn().mockResolvedValue({ status: 'RESOLVED', employeeId: 'p2' }) };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  // Позиции: 9–15 — юрист, конфиг, разборы, почта, память, регламенты; 16 — свободное время.
  const service = new AssistantToolsService(
    {} as any,
    events as any,
    {} as any,
    {} as any,
    prisma as any,
    audit as any,
    resolver as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    availability as any,
  );
  return { service, prisma, resolver };
}

describe('разбор входа и время', () => {
  it('создание: нет конца — час; конец раньше начала и событие длиннее суток — отказ', () => {
    const ok = parseCreateEventInput({ title: 'Звонок', startAt: '2026-10-30T15:00:00' });
    expect('error' in ok ? null : [ok.startAt?.toISOString(), ok.endAt?.toISOString()]).toEqual(['2026-10-30T10:00:00.000Z', '2026-10-30T11:00:00.000Z']);
    expect(parseCreateEventInput({ title: 'X', startAt: '2026-10-30T15:00:00', endAt: '2026-10-30T14:00:00' })).toHaveProperty('error');
    expect(parseCreateEventInput({ title: 'X', startAt: '2026-10-30T15:00:00', endAt: '2026-11-02T15:00:00' })).toHaveProperty('error');
    expect(parseCreateEventInput({ title: 'X' })).toHaveProperty('error');
  });

  it('перенос начала сохраняет длительность; только длительность — от прежнего начала', () => {
    const before = { startAt: at('2026-10-29T05:00:00Z'), endAt: at('2026-10-29T06:30:00Z') };
    expect(nextEventTimes(before, { startAt: at('2026-10-30T09:00:00Z') })).toEqual({ startAt: at('2026-10-30T09:00:00Z'), endAt: at('2026-10-30T10:30:00Z') });
    expect(nextEventTimes(before, { durationMinutes: 30 })).toEqual({ endAt: at('2026-10-29T05:30:00Z') });
    expect(nextEventTimes(before, {})).toEqual({});
  });

  it('время для модели — местное без смещения (UTC-строку модель сдвинула бы на 5 часов)', () => {
    expect(localIso(at('2026-10-29T05:00:00Z'))).toBe('2026-10-29T10:00:00');
    expect(toSlotData({ start: at('2026-10-29T05:00:00Z'), end: at('2026-10-29T06:00:00Z') })).toEqual({ start: '2026-10-29T10:00:00', end: '2026-10-29T11:00:00' });
  });

  it('поиск событий по умолчанию — с начала сегодняшнего дня по Алматы на неделю', () => {
    const parsed = parseFindEventsInput({}, at('2026-10-28T20:30:00Z')); // 29.10, 01:30 по Алматы
    expect(parsed.from.toISOString()).toBe('2026-10-28T19:00:00.000Z');
    expect(parsed.to.toISOString()).toBe('2026-11-04T19:00:00.000Z');
  });

  it('«было → стало»: время по Алматы, добавленные и убранные участники', () => {
    const changes = describeEventChanges(event(), event({ startAt: at('2026-10-30T05:00:00Z'), endAt: at('2026-10-30T06:00:00Z'), participants: [{ id: 'p2', fullName: 'Иванова Ирина' }] }));
    expect(changes).toEqual([
      { label: 'Начало', from: '29.10, 10:00', to: '30.10, 10:00' },
      { label: 'Окончание', from: '29.10, 11:00', to: '30.10, 11:00' },
      { label: 'Добавлены', from: null, to: 'Иванова Ирина' },
      { label: 'Убраны', from: null, to: 'Ким Арман' },
    ]);
  });
});

describe('CalendarAvailabilityService.findSlotsForAgent', () => {
  it('Google не подключён — занятость из календаря Адъютанта, googleChecked=false', async () => {
    const policy = { getOrDefault: jest.fn().mockResolvedValue({ ...defaultAvailabilityPolicy(), minNoticeHours: 0 }) };
    const freeBusy = { queryBusy: jest.fn().mockResolvedValue({ status: 'UNAVAILABLE' }) };
    // Четверг 29.10: занято 09:00–12:00 по Алматы.
    const events = { findBetween: jest.fn().mockResolvedValue([{ startAt: at('2026-10-29T04:00:00Z'), endAt: at('2026-10-29T07:00:00Z') }]) };
    const service = new CalendarAvailabilityService(policy as never, freeBusy as never, events as never);
    const result = await service.findSlotsForAgent('u1', at('2026-10-29T04:00:00Z'), at('2026-10-29T13:00:00Z'), 60, 1);
    expect(result.googleChecked).toBe(false);
    // Буфер 15 минут после занятого блока → первое окно 12:15 по Алматы.
    expect(result.slots[0].start.toISOString()).toBe('2026-10-29T07:15:00.000Z');
  });
});

describe('календарные инструменты ассистента', () => {
  it('руководителю — поиск, свободное время и правка; сотруднику — ничего из календаря; правки — write', async () => {
    const manager = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, { competency: { findMany: jest.fn().mockResolvedValue([]) } } as any);
    const names = (await manager.buildTools(user())).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['find_events', 'create_event', 'update_event', 'delete_event']));
    expect(names).not.toContain('find_free_slots'); // без CalendarAvailabilityService не предлагается
    const employee = (await new AssistantToolsService({} as any, {} as any, {} as any).buildTools(user({ role: Role.EMPLOYEE }))).map((t) => t.name);
    expect(employee.some((n) => n.endsWith('_event') || n === 'find_events')).toBe(false);
    for (const name of ['create_event', 'update_event', 'delete_event']) expect(isWriteTool(name)).toBe(true);
    expect(isWriteTool('find_events')).toBe(false);
  });

  it('сотрудник, вызвавший инструмент из старой истории, — CALENDAR_FORBIDDEN, ничего не создаётся', async () => {
    const events = { create: jest.fn() };
    const { service } = serviceWith(events);
    const result = await service.execute('create_event', { title: 'X', startAt: '2026-10-30T15:00:00' }, user({ role: Role.EMPLOYEE }), 'c1', 'm1', 0);
    expect('message' in result && result.message).toContain('CALENDAR_FORBIDDEN');
    expect(events.create).not.toHaveBeenCalled();
  });

  it('find_events: отменённые и не подходящие по слову отброшены; модели — без карточек', async () => {
    const events = {
      findAll: jest.fn().mockResolvedValue([event(), event({ id: 'e2', title: 'Обед', location: null }), event({ id: 'e3', status: 'CANCELLED' })]),
    };
    const { service } = serviceWith(events);
    const result = await service.execute('find_events', { query: 'планёр' }, user());
    expect(result).toMatchObject({ tool: 'find_events', totalCount: 1, items: [{ eventId: 'e1', start: '2026-10-29T10:00:00' }] });
    expect(toolResultForModel(result)).not.toHaveProperty('cards');
    expect(buildAssistantParts({ text: '', toolCalls: [{ name: 'find_events', result, durationMs: 1 }] }).filter((p) => p.type === 'EVENT_CARD')).toHaveLength(1);
  });

  it('find_free_slots — слоты местным временем, googleChecked передаётся', async () => {
    const availability = { findSlotsForAgent: jest.fn().mockResolvedValue({ slots: [{ start: at('2026-10-30T09:00:00Z'), end: at('2026-10-30T10:00:00Z') }], googleChecked: false }) };
    const { service } = serviceWith({}, availability);
    const result = await service.execute('find_free_slots', { durationMinutes: 60 }, user());
    expect(result).toEqual({ tool: 'find_free_slots', slots: [{ start: '2026-10-30T14:00:00', end: '2026-10-30T15:00:00' }], durationMinutes: 60, googleChecked: false });
  });

  it('create_event: участники по имени, отмена EVENT/CREATE в разговор карточки', async () => {
    const created = event({ participants: [] });
    const events = { create: jest.fn().mockResolvedValue(created), addParticipant: jest.fn().mockResolvedValue({}), findOne: jest.fn().mockResolvedValue(event({ participants: [{ id: 'p2', fullName: 'Иванова Ирина' }] })) };
    const { service, prisma } = serviceWith(events);
    const result = await service.execute('create_event', { title: 'Планёрка', startAt: '2026-10-29T10:00:00', participants: ['Ирину'] }, user(), 'c1', 'm1', 0);
    expect(events.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Планёрка', startAt: '2026-10-29T05:00:00.000Z', endAt: '2026-10-29T06:00:00.000Z' }), 'u1');
    expect(events.addParticipant).toHaveBeenCalledWith('e1', 'p2', 'u1');
    expect(prisma.undoRecord.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'EVENT', action: 'CREATE', entityId: 'e1', conversationId: 'c1' }) });
    expect(result).toMatchObject({ tool: 'create_event', event: { eventId: 'e1', undoToken: 'undo-1', participants: [{ name: 'Иванова Ирина' }] } });
    expect(prisma.row).toMatchObject({ status: 'COMPLETED' });
  });

  it('update_event: перенос с версией, снимок «до» и участники для отмены', async () => {
    const before = event();
    const after = event({ startAt: at('2026-10-30T05:00:00Z'), endAt: at('2026-10-30T06:00:00Z') });
    const events = { findOne: jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after), update: jest.fn().mockResolvedValue(after) };
    const { service, prisma } = serviceWith(events);
    const result = await service.execute('update_event', { eventId: 'e1', startAt: '2026-10-30T10:00:00' }, user(), 'c1', 'm1', 0);
    expect(events.update).toHaveBeenCalledWith('e1', { startAt: '2026-10-30T05:00:00.000Z', endAt: '2026-10-30T06:00:00.000Z', version: 3 }, 'u1');
    expect(prisma.undoRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'EVENT', action: 'UPDATE', previous: { startAt: '2026-10-29T05:00:00.000Z', endAt: '2026-10-29T06:00:00.000Z' } }),
    });
    expect(result).toMatchObject({ event: { changes: [{ label: 'Начало' }, { label: 'Окончание' }], undoToken: 'undo-1' } });
  });

  it('update_event: версия разошлась — EVENT_CHANGED, отмены нет', async () => {
    const events = { findOne: jest.fn().mockResolvedValue(event()), update: jest.fn().mockRejectedValue(new ConflictException('EVENT_VERSION_CONFLICT')) };
    const { service, prisma } = serviceWith(events);
    const result = await service.execute('update_event', { eventId: 'e1', title: 'Новая планёрка' }, user(), 'c1', 'm1', 0);
    expect('message' in result && result.message).toContain('EVENT_CHANGED');
    expect(prisma.undoRecord.create).not.toHaveBeenCalled();
    expect(prisma.row).toMatchObject({ status: 'FAILED' });
  });

  it('delete_event — без отмены, карточки нет', async () => {
    const events = { findOne: jest.fn().mockResolvedValue(event()), remove: jest.fn().mockResolvedValue(undefined) };
    const { service, prisma } = serviceWith(events);
    const result = await service.execute('delete_event', { eventId: 'e1' }, user(), 'c1', 'm1', 0);
    expect(events.remove).toHaveBeenCalledWith('e1', 'u1');
    expect(result).toEqual({ tool: 'delete_event', eventId: 'e1', title: 'Планёрка' });
    expect(prisma.undoRecord.create).not.toHaveBeenCalled();
  });
});

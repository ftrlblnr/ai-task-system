import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantToolsService } from './assistant-tools.service';

// buildTools/execute не трогают реальный Anthropic — только RBAC-видимость
// инструментов и маппинг/каппинг реальных Task/Event в карточки (Stage 2
// Phase C, §16 — LLM не сочиняет данные карточек, только решает вызвать
// инструмент).
function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, isProfileAdmin: false, ...overrides };
}

describe('AssistantToolsService.buildTools (Stage 2 §16 — RBAC на уровне видимости инструмента, не постфактум)', () => {
  it('сотруднику предлагается get_tasks и export_tasks_xlsx — календарь закрыт на OWNER', () => {
    const service = new AssistantToolsService({} as any, {} as any, {} as any);
    const names = service.buildTools(user()).map((t) => t.name);
    expect(names).toEqual(['get_tasks', 'export_tasks_xlsx']);
  });

  it('руководителю дополнительно предлагаются календарь и инструменты встреч (Stage 2, Phase K)', () => {
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, {} as any);
    const names = service.buildTools(user({ role: Role.OWNER })).map((t) => t.name);
    expect(names).toEqual([
      'get_tasks',
      'export_tasks_xlsx',
      'get_events',
      'get_recent_meetings',
      'search_meetings',
      'get_meeting',
      'search_meeting_transcript',
    ]);
  });
});

describe('AssistantToolsService.execute get_tasks (Stage 2 §5.2/§16 — только реальные Task, не выдумка модели)', () => {
  const tasks = Array.from({ length: 15 }, (_, i) => ({
    id: `t${i}`,
    title: `Задача ${i}`,
    status: 'IN_PROGRESS',
    dueDate: null,
    assignee: null,
    isOverdue: i < 12, // первые 12 просрочены
  }));

  it('filter=all — все задачи, capped на 10, totalCount = реальное число', async () => {
    const tasksStub = { findAll: jest.fn().mockResolvedValue(tasks) };
    const service = new AssistantToolsService(tasksStub as any, {} as any, {} as any);
    const result = await service.execute('get_tasks', { filter: 'all' }, user());
    expect(result).toMatchObject({ tool: 'get_tasks', totalCount: 15 });
    expect('items' in result && result.items).toHaveLength(10);
  });

  it('filter=overdue — фильтрует по isOverdue до каппинга (totalCount = 12, не 15)', async () => {
    const tasksStub = { findAll: jest.fn().mockResolvedValue(tasks) };
    const service = new AssistantToolsService(tasksStub as any, {} as any, {} as any);
    const result = await service.execute('get_tasks', { filter: 'overdue' }, user());
    expect(result).toMatchObject({ tool: 'get_tasks', totalCount: 12 });
    expect('items' in result && result.items).toHaveLength(10);
  });

  it('сбой TasksService.findAll превращается в {error:true} с безопасным кодом, не пробрасывает err.message наружу (аудит 16.09.2026)', async () => {
    const tasksStub = { findAll: jest.fn().mockRejectedValue(new Error('db down: password=secret')) };
    const service = new AssistantToolsService(tasksStub as any, {} as any, {} as any);
    const result = await service.execute('get_tasks', { filter: 'all' }, user());
    expect(result).toMatchObject({ tool: 'get_tasks', error: true });
    expect('message' in result && result.message).not.toContain('db down');
    expect('message' in result && result.message).toContain('TASK_LOOKUP_FAILED');
  });
});

describe('AssistantToolsService.execute get_events (Stage 2 §5.3 — только предстоящие подтверждённые встречи)', () => {
  it('отфильтровывает отменённые и прошедшие встречи', async () => {
    const now = Date.now();
    const events = [
      { id: 'e1', title: 'Прошедшая', location: null, startAt: new Date(now - 1000), endAt: new Date(now), status: 'CONFIRMED', participants: [] },
      { id: 'e2', title: 'Отменённая', location: null, startAt: new Date(now + 1000), endAt: new Date(now + 2000), status: 'CANCELLED', participants: [] },
      { id: 'e3', title: 'Предстоящая', location: null, startAt: new Date(now + 3000), endAt: new Date(now + 4000), status: 'CONFIRMED', participants: [] },
    ];
    const eventsStub = { findAll: jest.fn().mockResolvedValue(events) };
    const service = new AssistantToolsService({} as any, eventsStub as any, {} as any);
    const result = await service.execute('get_events', {}, user({ role: Role.OWNER }));
    expect(result).toMatchObject({ tool: 'get_events', totalCount: 1 });
    expect('items' in result && result.items[0].eventId).toBe('e3');
  });
});

describe('AssistantToolsService.execute export_tasks_xlsx (Stage 2, Phase G)', () => {
  const tasks = Array.from({ length: 15 }, (_, i) => ({
    id: `t${i}`,
    title: `Задача ${i}`,
    status: 'IN_PROGRESS',
    priority: 'MEDIUM',
    dueDate: null,
    assignee: null,
    isOverdue: i < 12,
  }));

  it('НЕ обрезает список до MAX_TOOL_ITEMS — весь смысл экспорта в том, чтобы увидеть больше 10 задач', async () => {
    const created = { id: 'f1', name: 'Задачи (все) 2026-09-16.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 1234 };
    const tasksStub = { findAll: jest.fn().mockResolvedValue(tasks) };
    const filesStub = { createGenerated: jest.fn().mockResolvedValue(created) };
    const service = new AssistantToolsService(tasksStub as any, {} as any, filesStub as any);

    const result = await service.execute('export_tasks_xlsx', { filter: 'all' }, user());

    expect(result).toMatchObject({ tool: 'export_tasks_xlsx', totalCount: 15 });
    expect(filesStub.createGenerated).toHaveBeenCalledTimes(1);
    const [, buffer, , mimeType] = filesStub.createGenerated.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect('file' in result && result.file).toEqual({ fileId: 'f1', name: created.name, mimeType: created.mimeType, size: created.size });
  });

  it('filter=overdue — фильтрует по isOverdue (totalCount = 12, не 15)', async () => {
    const created = { id: 'f2', name: 'Задачи (просроченные) 2026-09-16.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 999 };
    const tasksStub = { findAll: jest.fn().mockResolvedValue(tasks) };
    const filesStub = { createGenerated: jest.fn().mockResolvedValue(created) };
    const service = new AssistantToolsService(tasksStub as any, {} as any, filesStub as any);

    const result = await service.execute('export_tasks_xlsx', { filter: 'overdue' }, user());

    expect(result).toMatchObject({ tool: 'export_tasks_xlsx', totalCount: 12 });
  });

  it('сбой FilesService.createGenerated превращается в {error:true, EXPORT_FAILED}, не пробрасывает err.message', async () => {
    const tasksStub = { findAll: jest.fn().mockResolvedValue(tasks) };
    const filesStub = { createGenerated: jest.fn().mockRejectedValue(new Error('disk full: /data/uploads')) };
    const service = new AssistantToolsService(tasksStub as any, {} as any, filesStub as any);

    const result = await service.execute('export_tasks_xlsx', { filter: 'all' }, user());

    expect(result).toMatchObject({ tool: 'export_tasks_xlsx', error: true });
    expect('message' in result && result.message).not.toContain('disk full');
    expect('message' in result && result.message).toContain('EXPORT_FAILED');
  });
});

// Stage 2, Phase K (внешний аудит 21.09.2026, "Assistant meeting/Plaud
// tools") — до этих 4 инструментов Assistant не мог отвечать ни на один
// вопрос про прошлые встречи.
describe('AssistantToolsService.execute — инструменты встреч (Stage 2, Phase K)', () => {
  it('get_recent_meetings — берёт первые limit из уже отсортированного MeetingsService.findAll, totalCount = реальное число', async () => {
    const meetings = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, title: `Встреча ${i}`, meetingDate: new Date(2026, 8, 20 - i) }));
    const meetingsStub = { findAll: jest.fn().mockResolvedValue(meetings) };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, meetingsStub as any, {} as any);

    const result = await service.execute('get_recent_meetings', { limit: 3 }, user({ role: Role.OWNER }));

    expect(result).toMatchObject({ tool: 'get_recent_meetings', totalCount: 8 });
    expect('items' in result && result.items).toHaveLength(3);
    expect('items' in result && result.items[0].meetingId).toBe('m0');
  });

  it('get_recent_meetings — limit выше MAX_TOOL_ITEMS всё равно капается', async () => {
    const meetings = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, title: `Встреча ${i}`, meetingDate: new Date() }));
    const meetingsStub = { findAll: jest.fn().mockResolvedValue(meetings) };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, meetingsStub as any, {} as any);

    const result = await service.execute('get_recent_meetings', { limit: 100 }, user({ role: Role.OWNER }));

    expect('items' in result && result.items).toHaveLength(10);
  });

  it('search_meetings — пустой query не бьёт в БД, сразу пустой результат', async () => {
    const prismaStub = { meeting: { findMany: jest.fn(), count: jest.fn() } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any);

    const result = await service.execute('search_meetings', { query: '   ' }, user({ role: Role.OWNER }));

    expect(result).toEqual({ tool: 'search_meetings', items: [], totalCount: 0 });
    expect(prismaStub.meeting.findMany).not.toHaveBeenCalled();
  });

  it('search_meetings — ищет по title/rawSummary/enhancedSummary без учёта регистра', async () => {
    const found = [{ id: 'm1', title: 'Встреча про завод', meetingDate: new Date('2026-09-01') }];
    const prismaStub = { meeting: { findMany: jest.fn().mockResolvedValue(found), count: jest.fn().mockResolvedValue(1) } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any);

    const result = await service.execute('search_meetings', { query: 'завод' }, user({ role: Role.OWNER }));

    expect(result).toMatchObject({ tool: 'search_meetings', totalCount: 1 });
    expect(prismaStub.meeting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { title: { contains: 'завод', mode: 'insensitive' } },
            { rawSummary: { contains: 'завод', mode: 'insensitive' } },
            { enhancedSummary: { contains: 'завод', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });

  it('get_meeting — делегирует MeetingsService.findOne (тот же audit.log/404), предпочитает enhancedSummary', async () => {
    const meeting = { id: 'm1', title: 'Встреча', meetingDate: new Date('2026-09-01'), rawSummary: 'сырое', enhancedSummary: 'обработанное' };
    const meetingsStub = { findOne: jest.fn().mockResolvedValue(meeting) };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, meetingsStub as any, {} as any);

    const result = await service.execute('get_meeting', { meetingId: 'm1' }, user({ role: Role.OWNER, id: 'owner1' }));

    expect(meetingsStub.findOne).toHaveBeenCalledWith('m1', 'owner1');
    expect(result).toMatchObject({ tool: 'get_meeting', meeting: { meetingId: 'm1', summary: 'обработанное' } });
  });

  it('get_meeting — без enhancedSummary отдаёт rawSummary', async () => {
    const meeting = { id: 'm1', title: 'Встреча', meetingDate: new Date('2026-09-01'), rawSummary: 'сырое', enhancedSummary: null };
    const meetingsStub = { findOne: jest.fn().mockResolvedValue(meeting) };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, meetingsStub as any, {} as any);

    const result = await service.execute('get_meeting', { meetingId: 'm1' }, user({ role: Role.OWNER }));

    expect(result).toMatchObject({ meeting: { summary: 'сырое' } });
  });

  it('get_meeting — MeetingsService.findOne бросает NotFoundException — безопасный error, не 404-текст наружу', async () => {
    const meetingsStub = { findOne: jest.fn().mockRejectedValue(new Error('Встреча не найдена')) };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, meetingsStub as any, {} as any);

    const result = await service.execute('get_meeting', { meetingId: 'ghost' }, user({ role: Role.OWNER }));

    expect(result).toMatchObject({ tool: 'get_meeting', error: true });
    expect('message' in result && result.message).toContain('MEETING_LOOKUP_FAILED');
  });

  it('search_meeting_transcript — пустой query не бьёт в БД', async () => {
    const prismaStub = { meetingSegment: { findMany: jest.fn(), count: jest.fn() } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any);

    const result = await service.execute('search_meeting_transcript', { query: '' }, user({ role: Role.OWNER }));

    expect(result).toEqual({ tool: 'search_meeting_transcript', items: [], totalCount: 0 });
    expect(prismaStub.meetingSegment.findMany).not.toHaveBeenCalled();
  });

  it('search_meeting_transcript — находит реплики, опционально ограничивает одной встречей', async () => {
    const found = [{ meetingId: 'm1', speakerLabel: 'Жандос', startMs: 60000, endMs: 65000, text: 'по договору', meeting: { title: 'Встреча про завод' } }];
    const prismaStub = { meetingSegment: { findMany: jest.fn().mockResolvedValue(found), count: jest.fn().mockResolvedValue(1) } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any);

    const result = await service.execute('search_meeting_transcript', { query: 'договор', meetingId: 'm1' }, user({ role: Role.OWNER }));

    expect(result).toMatchObject({
      tool: 'search_meeting_transcript',
      totalCount: 1,
      items: [{ meetingId: 'm1', meetingTitle: 'Встреча про завод', speakerLabel: 'Жандос', text: 'по договору' }],
    });
    expect(prismaStub.meetingSegment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { text: { contains: 'договор', mode: 'insensitive' }, meetingId: 'm1' } }),
    );
  });

  it('search_meeting_transcript — без транскрипта (ничего не найдено) отдаёт пустой items, не бросает', async () => {
    const prismaStub = { meetingSegment: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any);

    const result = await service.execute('search_meeting_transcript', { query: 'что угодно' }, user({ role: Role.OWNER }));

    expect(result).toEqual({ tool: 'search_meeting_transcript', items: [], totalCount: 0 });
  });
});

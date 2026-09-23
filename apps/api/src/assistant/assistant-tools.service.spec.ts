import { Prisma, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantToolsService } from './assistant-tools.service';

function p2002(message = 'Unique constraint failed'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code: 'P2002', clientVersion: '6.19.3' });
}

// buildTools/execute не трогают реальный Anthropic — только RBAC-видимость
// инструментов и маппинг/каппинг реальных Task/Event в карточки (Stage 2
// Phase C, §16 — LLM не сочиняет данные карточек, только решает вызвать
// инструмент).
function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, isProfileAdmin: false, ...overrides };
}

describe('AssistantToolsService.buildTools (Stage 2 §16 — RBAC на уровне видимости инструмента, не постфактум)', () => {
  it('сотруднику предлагается get_tasks и export_tasks_xlsx — календарь закрыт на OWNER', async () => {
    const service = new AssistantToolsService({} as any, {} as any, {} as any);
    const names = (await service.buildTools(user())).map((t) => t.name);
    expect(names).toEqual(['get_tasks', 'export_tasks_xlsx']);
  });

  it('руководителю дополнительно предлагаются календарь и инструменты встреч (Stage 2, Phase K), без компетенций в компании — find_employee_by_competency не предлагается', async () => {
    const prisma = { competency: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prisma as any);
    const names = (await service.buildTools(user({ role: Role.OWNER }))).map((t) => t.name);
    expect(names).toEqual([
      'get_tasks',
      'export_tasks_xlsx',
      'get_events',
      'get_recent_meetings',
      'search_meetings',
      'get_meeting',
      'search_meeting_transcript',
      'create_task_from_meeting',
    ]);
  });

  // Stage 2, Phase P (Competency-based assignee routing, 22.09.2026).
  it('руководителю, если в компании настроены компетенции, предлагается find_employee_by_competency с закрытым enum реальных id', async () => {
    const competencies = [
      { id: 'c1', name: 'Юридические вопросы', description: 'Договоры, споры' },
      { id: 'c2', name: 'Бухгалтерия', description: 'Счета, отчётность' },
    ];
    const prisma = { competency: { findMany: jest.fn().mockResolvedValue(competencies) } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prisma as any);
    const tools = await service.buildTools(user({ role: Role.OWNER }));
    const tool = tools.find((t) => t.name === 'find_employee_by_competency');

    expect(tool).toBeDefined();
    expect((tool!.input_schema.properties as any).competencyId.enum).toEqual(['c1', 'c2']);
    expect(tool!.description).toContain('Юридические вопросы');
    expect(tool!.description).toContain('Бухгалтерия');
  });

  it('сотруднику (не OWNER) find_employee_by_competency не предлагается, даже если компетенции есть', async () => {
    const prisma = { competency: { findMany: jest.fn() } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prisma as any);
    const names = (await service.buildTools(user())).map((t) => t.name);

    expect(names).not.toContain('find_employee_by_competency');
    expect(prisma.competency.findMany).not.toHaveBeenCalled();
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

  // roadmap v13, MUST-FIX #1 (23.09.2026) — source прокидывается в
  // MeetingsService.findAll как есть; любой мусор от модели безопасно
  // трактуется как 'all', не 'plaud' (иначе можно было бы случайно
  // спрятать все не-Plaud встречи от честного вопроса "все встречи").
  it("get_recent_meetings — source='plaud' доходит до MeetingsService.findAll('plaud')", async () => {
    const meetingsStub = { findAll: jest.fn().mockResolvedValue([]) };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, meetingsStub as any, {} as any);

    await service.execute('get_recent_meetings', { source: 'plaud' }, user({ role: Role.OWNER }));

    expect(meetingsStub.findAll).toHaveBeenCalledWith('plaud');
  });

  it("get_recent_meetings — source отсутствует/невалиден → MeetingsService.findAll('all')", async () => {
    const meetingsStub = { findAll: jest.fn().mockResolvedValue([]) };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, meetingsStub as any, {} as any);

    await service.execute('get_recent_meetings', {}, user({ role: Role.OWNER }));
    await service.execute('get_recent_meetings', { source: 'garbage' }, user({ role: Role.OWNER }));

    expect(meetingsStub.findAll).toHaveBeenNthCalledWith(1, 'all');
    expect(meetingsStub.findAll).toHaveBeenNthCalledWith(2, 'all');
  });

  it('search_meetings — пустой query не бьёт в БД, сразу пустой результат', async () => {
    const prismaStub = { meeting: { findMany: jest.fn(), count: jest.fn() } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any);

    const result = await service.execute('search_meetings', { query: '   ' }, user({ role: Role.OWNER }));

    expect(result).toEqual({ tool: 'search_meetings', items: [], totalCount: 0 });
    expect(prismaStub.meeting.findMany).not.toHaveBeenCalled();
  });

  it('search_meetings — ищет по title/rawSummary/latestSummary/enhancedSummary без учёта регистра', async () => {
    const found = [{ id: 'm1', title: 'Встреча про завод', meetingDate: new Date('2026-09-01') }];
    const prismaStub = { meeting: { findMany: jest.fn().mockResolvedValue(found), count: jest.fn().mockResolvedValue(1) } };
    const auditStub = { log: jest.fn() };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, auditStub as any);

    const result = await service.execute('search_meetings', { query: 'завод' }, user({ role: Role.OWNER, id: 'owner1' }));

    expect(result).toMatchObject({ tool: 'search_meetings', totalCount: 1 });
    expect(prismaStub.meeting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { title: { contains: 'завод', mode: 'insensitive' } },
            { rawSummary: { contains: 'завод', mode: 'insensitive' } },
            { latestSummary: { contains: 'завод', mode: 'insensitive' } },
            { enhancedSummary: { contains: 'завод', mode: 'insensitive' } },
          ],
        },
      }),
    );
  });

  // Доп. P2-находка седьмого внешнего аудита — search_meetings раньше не
  // оставлял следа в AuditLog вообще (в отличие от MeetingsService.findOne/
  // extractTasks, где раздел 15 ТЗ уже соблюдался для отдельной встречи).
  it('search_meetings — успешный непустой поиск логируется в AuditLog как AI_MEETING_SEARCH', async () => {
    const found = [{ id: 'm1', title: 'Встреча про завод', meetingDate: new Date('2026-09-01') }];
    const prismaStub = { meeting: { findMany: jest.fn().mockResolvedValue(found), count: jest.fn().mockResolvedValue(1) } };
    const auditStub = { log: jest.fn() };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, auditStub as any);

    await service.execute('search_meetings', { query: 'завод' }, user({ role: Role.OWNER, id: 'owner1' }));

    expect(auditStub.log).toHaveBeenCalledWith('owner1', 'AI_MEETING_SEARCH', 'Meeting', 'завод', { resultCount: 1 });
  });

  it('search_meetings — пустой query не пишет в AuditLog', async () => {
    const prismaStub = { meeting: { findMany: jest.fn(), count: jest.fn() } };
    const auditStub = { log: jest.fn() };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, auditStub as any);

    await service.execute('search_meetings', { query: '   ' }, user({ role: Role.OWNER }));

    expect(auditStub.log).not.toHaveBeenCalled();
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

  // РЕГРЕССИЯ находки №4 седьмого внешнего аудита (Stage 2, Phase N,
  // "Plaud summary freshness") — раньше latestSummary не существовал
  // вообще, Assistant всегда отвечал по замороженной rawSummary, даже
  // если Plaud обновил содержимое встречи.
  it('get_meeting — без enhancedSummary, но с latestSummary — предпочитает latestSummary над rawSummary', async () => {
    const meeting = { id: 'm1', title: 'Встреча', meetingDate: new Date('2026-09-01'), rawSummary: 'исходное', latestSummary: 'обновлённое с Plaud', enhancedSummary: null };
    const meetingsStub = { findOne: jest.fn().mockResolvedValue(meeting) };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, meetingsStub as any, {} as any);

    const result = await service.execute('get_meeting', { meetingId: 'm1' }, user({ role: Role.OWNER }));

    expect(result).toMatchObject({ meeting: { summary: 'обновлённое с Plaud' } });
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
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, { log: jest.fn() } as any);

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

  // Доп. P2-находка седьмого внешнего аудита — search_meeting_transcript
  // раньше не оставлял следа в AuditLog вообще. entityId — meetingId, если
  // поиск сужен на конкретную встречу (есть реальная целевая запись).
  it('search_meeting_transcript — успешный поиск по конкретной встрече логируется в AuditLog как AI_TRANSCRIPT_SEARCH с entityId=meetingId', async () => {
    const found = [{ meetingId: 'm1', speakerLabel: 'Жандос', startMs: 60000, endMs: 65000, text: 'по договору', meeting: { title: 'Встреча про завод' } }];
    const prismaStub = { meetingSegment: { findMany: jest.fn().mockResolvedValue(found), count: jest.fn().mockResolvedValue(1) } };
    const auditStub = { log: jest.fn() };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, auditStub as any);

    await service.execute('search_meeting_transcript', { query: 'договор', meetingId: 'm1' }, user({ role: Role.OWNER, id: 'owner1' }));

    expect(auditStub.log).toHaveBeenCalledWith('owner1', 'AI_TRANSCRIPT_SEARCH', 'Meeting', 'm1', { query: 'договор', meetingId: 'm1', resultCount: 1 });
  });

  it('search_meeting_transcript — поиск без ограничения встречей логирует entityId=запрос', async () => {
    const found = [{ meetingId: 'm1', speakerLabel: 'Жандос', startMs: 60000, endMs: 65000, text: 'по договору', meeting: { title: 'Встреча про завод' } }];
    const prismaStub = { meetingSegment: { findMany: jest.fn().mockResolvedValue(found), count: jest.fn().mockResolvedValue(1) } };
    const auditStub = { log: jest.fn() };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, auditStub as any);

    await service.execute('search_meeting_transcript', { query: 'договор' }, user({ role: Role.OWNER, id: 'owner1' }));

    expect(auditStub.log).toHaveBeenCalledWith('owner1', 'AI_TRANSCRIPT_SEARCH', 'Meeting', 'договор', { query: 'договор', meetingId: null, resultCount: 1 });
  });

  it('search_meeting_transcript — пустой query не пишет в AuditLog', async () => {
    const prismaStub = { meetingSegment: { findMany: jest.fn(), count: jest.fn() } };
    const auditStub = { log: jest.fn() };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, auditStub as any);

    await service.execute('search_meeting_transcript', { query: '' }, user({ role: Role.OWNER }));

    expect(auditStub.log).not.toHaveBeenCalled();
  });

  // Находка №3 шестого внешнего аудита (Stage 2, Phase M) — раньше
  // инструмент отдавал только сырую speakerLabel ("Speaker 2"), даже если
  // MeetingsService.updateSpeakers уже резолвил говорящего в сотрудника —
  // Assistant не мог ответить "Жандос сказал", только "Speaker 2 сказал".
  it('search_meeting_transcript — говорящий сопоставлен с сотрудником, отдаёт speakerName/speakerEmployeeId', async () => {
    const found = [
      {
        meetingId: 'm1',
        speakerLabel: 'Speaker 2',
        speakerEmployeeId: 'e1',
        speakerEmployee: { fullName: 'Жандос Ахметов' },
        startMs: 60000,
        endMs: 65000,
        text: 'по договору',
        meeting: { title: 'Встреча про завод' },
      },
    ];
    const prismaStub = { meetingSegment: { findMany: jest.fn().mockResolvedValue(found), count: jest.fn().mockResolvedValue(1) } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, { log: jest.fn() } as any);

    const result = await service.execute('search_meeting_transcript', { query: 'договор' }, user({ role: Role.OWNER }));

    expect(result).toMatchObject({
      items: [{ speakerLabel: 'Speaker 2', speakerEmployeeId: 'e1', speakerName: 'Жандос Ахметов' }],
    });
  });

  it('search_meeting_transcript — говорящий НЕ сопоставлен — speakerEmployeeId/speakerName оба null', async () => {
    const found = [{ meetingId: 'm1', speakerLabel: 'Speaker 1', speakerEmployeeId: null, speakerEmployee: null, startMs: 0, endMs: 1000, text: 'привет', meeting: { title: 'Встреча' } }];
    const prismaStub = { meetingSegment: { findMany: jest.fn().mockResolvedValue(found), count: jest.fn().mockResolvedValue(1) } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, { log: jest.fn() } as any);

    const result = await service.execute('search_meeting_transcript', { query: 'привет' }, user({ role: Role.OWNER }));

    expect(result).toMatchObject({ items: [{ speakerEmployeeId: null, speakerName: null }] });
  });

  it('search_meeting_transcript — без транскрипта (ничего не найдено) отдаёт пустой items, не бросает', async () => {
    const prismaStub = { meetingSegment: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prismaStub as any, { log: jest.fn() } as any);

    const result = await service.execute('search_meeting_transcript', { query: 'что угодно' }, user({ role: Role.OWNER }));

    expect(result).toEqual({ tool: 'search_meeting_transcript', items: [], totalCount: 0 });
  });
});

// Stage 2, Phase O (Meeting → Task workflow, 22.09.2026) — ПЕРВЫЙ write-tool
// Assistant Core. LLM — не security boundary (раздел 7 спеки), поэтому
// каждый тест ниже фокусируется на том, что реально перепроверяется на
// бэкенде, а не на слово модели.
describe('AssistantToolsService.execute create_task_from_meeting (Stage 2, Phase O)', () => {
  const owner = user({ id: 'owner1', role: Role.OWNER });
  const meeting = { id: 'm1', title: 'Автоматизация завода', meetingDate: new Date('2026-09-21T10:00:00Z') };
  const createdTask = { id: 't1', title: 'Получить КП', status: 'NEW', dueDate: null, assignee: null };

  function makeDeps(overrides: {
    meetingsFindOne?: jest.Mock;
    segment?: { id: string; meetingId: string; startMs: number } | null;
    employees?: { id: string; fullName: string }[];
    resolve?: jest.Mock;
    tasksCreate?: jest.Mock;
    taskFindUnique?: jest.Mock;
    executionCreate?: jest.Mock;
    executionFindUnique?: jest.Mock;
    executionUpdate?: jest.Mock;
  } = {}) {
    const meetingsStub = { findOne: overrides.meetingsFindOne ?? jest.fn().mockResolvedValue(meeting) };
    const tasksStub = { create: overrides.tasksCreate ?? jest.fn().mockResolvedValue(createdTask) };
    const auditStub = { log: jest.fn() };
    const employeeResolverStub = { resolve: overrides.resolve ?? jest.fn().mockResolvedValue({ status: 'RESOLVED', employeeId: 'e1' }) };
    const prisma = {
      meetingSegment: { findUnique: jest.fn().mockResolvedValue(overrides.segment === undefined ? null : overrides.segment) },
      employee: { findMany: jest.fn().mockResolvedValue(overrides.employees ?? [{ id: 'e1', fullName: 'Жандос Ахметов' }]) },
      // Hardening (P0, crash-safe) — Task.findUnique({sourceExecutionId})
      // по умолчанию "ничего не найдено" (обычный путь, execution ещё не
      // привязан ни к одной Task); тесты crash-safety переопределяют.
      task: { findUnique: overrides.taskFindUnique ?? jest.fn().mockResolvedValue(null) },
      taskFromMeetingExecution: {
        create: overrides.executionCreate ?? jest.fn().mockResolvedValue({ id: 'exec1' }),
        findUnique: overrides.executionFindUnique ?? jest.fn(),
        update: overrides.executionUpdate ?? jest.fn(),
      },
    };
    const service = new AssistantToolsService(tasksStub as any, {} as any, {} as any, meetingsStub as any, prisma as any, auditStub as any, employeeResolverStub as any);
    return { service, meetingsStub, tasksStub, auditStub, employeeResolverStub, prisma };
  }

  const baseInput = { meetingId: 'm1', title: 'Получить КП' };
  // execute()'s 7-й параметр — toolCallIndex (обязателен для
  // create_task_from_meeting, см. execute()'s guard); большинство тестов
  // ниже используют один и тот же вызов в изоляции — конкретное значение
  // не важно само по себе, важно только то, что оно ЕСТЬ.
  const call = (service: any, input: unknown, u = owner, idx = 0) => service.execute('create_task_from_meeting', input, u, 'c1', 'msg1', idx);

  it('встреча не найдена — безопасная ошибка, TasksService.create не вызывается', async () => {
    const { service, tasksStub } = makeDeps({ meetingsFindOne: jest.fn().mockRejectedValue(new Error('Встреча не найдена')) });

    const result = await call(service, baseInput);

    expect(result).toMatchObject({ tool: 'create_task_from_meeting', error: true });
    expect('message' in result && result.message).toContain('MEETING_LOOKUP_FAILED');
    expect(tasksStub.create).not.toHaveBeenCalled();
  });

  it('segmentId принадлежит ДРУГОЙ встрече — SEGMENT_MISMATCH, задача не создаётся', async () => {
    const { service, tasksStub } = makeDeps({ segment: { id: 's1', meetingId: 'm-other', startMs: 1000 } });

    const result = await call(service, { ...baseInput, segmentId: 's1' });

    expect('message' in result && result.message).toContain('SEGMENT_MISMATCH');
    expect(tasksStub.create).not.toHaveBeenCalled();
  });

  it('segmentId не существует вовсе — тот же SEGMENT_MISMATCH, задача не создаётся', async () => {
    const { service, tasksStub } = makeDeps({ segment: null });

    const result = await call(service, { ...baseInput, segmentId: 'ghost' });

    expect('message' in result && result.message).toContain('SEGMENT_MISMATCH');
    expect(tasksStub.create).not.toHaveBeenCalled();
  });

  it('без segmentId (источник — саммари) — успешно создаёт, source.timestamp = null', async () => {
    const { service } = makeDeps();

    const result = await call(service, baseInput);

    expect(result).toMatchObject({ tool: 'create_task_from_meeting', task: { source: { meetingId: 'm1', timestamp: null } } });
  });

  it('с segmentId — TasksService.create получает sourceSegmentId, sourceExecutionId и отформатированный sourceTimestamp, source.timestamp в ответе тоже заполнен', async () => {
    const { service, tasksStub } = makeDeps({ segment: { id: 's1', meetingId: 'm1', startMs: 65000 } });

    const result = await call(service, { ...baseInput, segmentId: 's1' });

    expect(tasksStub.create).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMeetingId: 'm1', sourceSegmentId: 's1', sourceExecutionId: 'exec1', sourceTimestamp: '1:05' }),
      owner,
    );
    expect(result).toMatchObject({ task: { source: { timestamp: '1:05' } } });
  });

  it('assigneeRawText резолвится (RESOLVED) — TasksService.create получает найденный assigneeId', async () => {
    const { service, tasksStub } = makeDeps({ resolve: jest.fn().mockResolvedValue({ status: 'RESOLVED', employeeId: 'e1' }) });

    await call(service, { ...baseInput, assigneeRawText: 'Жандосу' });

    expect(tasksStub.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeId: 'e1' }), owner);
  });

  it('assigneeRawText неоднозначен (AMBIGUOUS) — задача НЕ создаётся, execution помечается FAILED', async () => {
    const { service, tasksStub, prisma } = makeDeps({ resolve: jest.fn().mockResolvedValue({ status: 'AMBIGUOUS', employeeId: null }) });

    const result = await call(service, { ...baseInput, assigneeRawText: 'Алексей' });

    expect('message' in result && result.message).toContain('ASSIGNEE_AMBIGUOUS');
    expect(tasksStub.create).not.toHaveBeenCalled();
    expect(prisma.taskFromMeetingExecution.update).toHaveBeenCalledWith({ where: { id: 'exec1' }, data: expect.objectContaining({ status: 'FAILED' }) });
  });

  it('assigneeRawText не найден (NOT_FOUND) — задача НЕ создаётся', async () => {
    const { service, tasksStub } = makeDeps({ resolve: jest.fn().mockResolvedValue({ status: 'NOT_FOUND', employeeId: null }) });

    const result = await call(service, { ...baseInput, assigneeRawText: 'Незнакомец' });

    expect('message' in result && result.message).toContain('ASSIGNEE_NOT_FOUND');
    expect(tasksStub.create).not.toHaveBeenCalled();
  });

  it('assigneeRawText не передан — TasksService.create получает assigneeId: undefined, резолвер не вызывается', async () => {
    const { service, tasksStub, employeeResolverStub } = makeDeps();

    await call(service, baseInput);

    expect(employeeResolverStub.resolve).not.toHaveBeenCalled();
    expect(tasksStub.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeId: undefined }), owner);
  });

  it('успешное создание пишет AI_MEETING_TASK_CREATE в AuditLog без полного транскрипта', async () => {
    const { service, auditStub } = makeDeps();

    await call(service, { ...baseInput, assigneeRawText: 'Жандосу', dueDate: '2026-09-26T10:00:00' });

    expect(auditStub.log).toHaveBeenCalledWith('owner1', 'AI_MEETING_TASK_CREATE', 'Task', 't1', {
      meetingId: 'm1',
      segmentId: null,
      assigneeId: 'e1',
      dueDate: '2026-09-26T10:00:00',
    });
  });

  it('dueDate приводится к местному времени с явным смещением (withLocalOffset), как в voice', async () => {
    const { service, tasksStub } = makeDeps();

    await call(service, { ...baseInput, dueDate: '2026-09-26T10:00:00' });

    expect(tasksStub.create).toHaveBeenCalledWith(expect.objectContaining({ dueDate: '2026-09-26T10:00:00+05:00' }), owner);
  });

  // Hardening-раунд (22.09.2026, P0/P1) — dedupeKey/идемпотентность.
  describe('идемпотентность (hardening 22.09.2026)', () => {
    it('dedupeKey строится из (userMessageId, toolCallIndex), НЕ из meetingId/title', async () => {
      const { service, prisma } = makeDeps();

      await call(service, baseInput, owner, 3);

      expect(prisma.taskFromMeetingExecution.create).toHaveBeenCalledWith({ data: { conversationId: 'c1', dedupeKey: 'msg1:3' } });
    });

    // РЕГРЕССИЯ P0/P1 находки №1 отчёта — старый ключ включал title,
    // из-за чего Амир/Жандос с ОДИНАКОВЫМ пунктом встречи схлопывались бы
    // в одну задачу. Теперь разный toolCallIndex → разный ключ → разные
    // execution-записи, обе задачи создаются независимо.
    it('два вызова в одном ответе с одинаковым title, но разным assignee/toolCallIndex — НЕ схлопываются (разные dedupeKey)', async () => {
      const { service, prisma } = makeDeps();
      const executionCreate = prisma.taskFromMeetingExecution.create as jest.Mock;

      await call(service, { ...baseInput, assigneeRawText: 'Амиру' }, owner, 0);
      await call(service, { ...baseInput, assigneeRawText: 'Жандосу' }, owner, 1);

      expect(executionCreate).toHaveBeenNthCalledWith(1, { data: { conversationId: 'c1', dedupeKey: 'msg1:0' } });
      expect(executionCreate).toHaveBeenNthCalledWith(2, { data: { conversationId: 'c1', dedupeKey: 'msg1:1' } });
    });

    // РЕГРЕССИЯ P0/P1 находки №2 отчёта — раньше перефразированный моделью
    // title менял dedupeKey, и ретрай не распознавался. Теперь ключ не
    // зависит от title вовсе — тот же (userMessageId, toolCallIndex) с
    // ДРУГИМ title всё равно ловит P2002 и уходит в reclaim/crash-safe
    // ветку, не создаёт вторую задачу.
    it('ретрай с ДРУГИМ (перефразированным) title, но тем же (userMessageId, toolCallIndex) — распознаётся как дубликат через P2002', async () => {
      const existingExecution = { id: 'exec1', status: 'FAILED', taskId: null, updatedAt: new Date() };
      const { service, tasksStub } = makeDeps({
        executionCreate: jest.fn().mockRejectedValue(p2002()),
        executionFindUnique: jest.fn().mockResolvedValue(existingExecution),
      });

      const result = await call(service, { ...baseInput, title: 'Запросить коммерческое предложение IDAT (перефразировано)' }, owner, 0);

      expect(tasksStub.create).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ tool: 'create_task_from_meeting', task: { taskId: 't1' } });
    });

    // РЕГРЕССИЯ P0 находки №1 отчёта (crash-safety) — execution мог
    // остаться CLAIMED (даже свежий, не stale), если процесс упал ПОСЛЕ
    // tasks.create(), но ДО обновления execution в COMPLETED. Проверка по
    // Task.sourceExecutionId (не по execution.status) должна найти уже
    // созданную Task и вернуть её, а НЕ пытаться создать вторую.
    it('crash-safety: execution завис в свежем CLAIMED, но Task с этим sourceExecutionId уже реально существует — возвращает её, НЕ создаёт вторую, самоисцеляет execution', async () => {
      const existingExecution = { id: 'exec1', status: 'CLAIMED', taskId: null, updatedAt: new Date() };
      const alreadyCreatedTask = { id: 't1', title: 'Получить КП', status: 'NEW', dueDate: null, assignee: null };
      const { service, tasksStub, prisma } = makeDeps({
        executionCreate: jest.fn().mockRejectedValue(p2002()),
        executionFindUnique: jest.fn().mockResolvedValue(existingExecution),
        taskFindUnique: jest.fn().mockResolvedValue(alreadyCreatedTask),
      });

      const result = await call(service, baseInput);

      expect(result).toMatchObject({ tool: 'create_task_from_meeting', task: { taskId: 't1' } });
      expect(tasksStub.create).not.toHaveBeenCalled();
      expect(prisma.task.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { sourceExecutionId: 'exec1' } }));
      expect(prisma.taskFromMeetingExecution.update).toHaveBeenCalledWith({
        where: { id: 'exec1' },
        data: { status: 'COMPLETED', taskId: 't1', errorMessage: null },
      });
    });

    it('crash-safety: execution уже COMPLETED и консистентен (taskId совпадает с найденной Task) — возвращает Task, execution НЕ обновляется повторно', async () => {
      const existingExecution = { id: 'exec1', status: 'COMPLETED', taskId: 't1', updatedAt: new Date() };
      const alreadyCreatedTask = { id: 't1', title: 'Получить КП', status: 'NEW', dueDate: null, assignee: null };
      const { service, tasksStub, prisma } = makeDeps({
        executionCreate: jest.fn().mockRejectedValue(p2002()),
        executionFindUnique: jest.fn().mockResolvedValue(existingExecution),
        taskFindUnique: jest.fn().mockResolvedValue(alreadyCreatedTask),
      });

      const result = await call(service, baseInput);

      expect(result).toMatchObject({ tool: 'create_task_from_meeting', task: { taskId: 't1' } });
      expect(tasksStub.create).not.toHaveBeenCalled();
      expect(prisma.taskFromMeetingExecution.update).not.toHaveBeenCalled();
    });

    it('FAILED execution, Task ещё нет — допускает повтор, TasksService.create вызывается, execution переиспользуется', async () => {
      const existingExecution = { id: 'exec1', status: 'FAILED', taskId: null, updatedAt: new Date() };
      const { service, tasksStub, prisma } = makeDeps({
        executionCreate: jest.fn().mockRejectedValue(p2002()),
        executionFindUnique: jest.fn().mockResolvedValue(existingExecution),
      });

      const result = await call(service, baseInput);

      expect(tasksStub.create).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ tool: 'create_task_from_meeting', task: { taskId: 't1' } });
      expect(prisma.taskFromMeetingExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'exec1' }, data: expect.objectContaining({ status: 'CLAIMED' }) }),
      );
    });

    it('свежий CLAIMED, Task ещё нет (реально конкурентный вызов) — безопасный отказ, TasksService.create НЕ вызывается', async () => {
      const existingExecution = { id: 'exec1', status: 'CLAIMED', taskId: null, updatedAt: new Date() };
      const { service, tasksStub } = makeDeps({
        executionCreate: jest.fn().mockRejectedValue(p2002()),
        executionFindUnique: jest.fn().mockResolvedValue(existingExecution),
      });

      const result = await call(service, baseInput);

      expect('message' in result && result.message).toContain('ALREADY_PROCESSING');
      expect(tasksStub.create).not.toHaveBeenCalled();
    });

    it('устаревший (stale) CLAIMED, Task ещё нет — брошенный процесс, безопасно переиспользуется', async () => {
      const staleDate = new Date(Date.now() - 5 * 60 * 1000); // 5 минут назад
      const existingExecution = { id: 'exec1', status: 'CLAIMED', taskId: null, updatedAt: staleDate };
      const { service, tasksStub } = makeDeps({
        executionCreate: jest.fn().mockRejectedValue(p2002()),
        executionFindUnique: jest.fn().mockResolvedValue(existingExecution),
      });

      const result = await call(service, baseInput);

      expect(tasksStub.create).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ tool: 'create_task_from_meeting', task: { taskId: 't1' } });
    });
  });

  it('TasksService.create падает — execution помечается FAILED, безопасная generic-ошибка наружу', async () => {
    const { service, prisma } = makeDeps({ tasksCreate: jest.fn().mockRejectedValue(new Error('db down: password=secret')) });

    const result = await call(service, baseInput);

    expect(result).toMatchObject({ tool: 'create_task_from_meeting', error: true, message: expect.stringContaining('TASK_CREATE_FAILED') });
    expect('message' in result && result.message).not.toContain('password');
    expect(prisma.taskFromMeetingExecution.update).toHaveBeenCalledWith({ where: { id: 'exec1' }, data: expect.objectContaining({ status: 'FAILED' }) });
  });

  it('conversationId/userMessageId отсутствуют — безопасный отказ, ничего не создаёт (не должно случаться на практике, см. execute())', async () => {
    const { service, tasksStub } = makeDeps();

    const result = await (service as any).execute('create_task_from_meeting', baseInput, owner);

    expect(result).toMatchObject({ error: true });
    expect(tasksStub.create).not.toHaveBeenCalled();
  });
});

// Stage 2, Phase P (Competency-based assignee routing, 22.09.2026) —
// backend только ЧЕСТНО отдаёт список сотрудников с данной компетенцией
// (0/1/много), ничего не выбирает сам — раздел 7 спеки: LLM не security
// boundary, поэтому финальный assigneeId всегда идёт через отдельный,
// уже захардененный create_task_from_meeting → EmployeeResolverService.
describe('AssistantToolsService.execute find_employee_by_competency (Stage 2, Phase P)', () => {
  const owner = user({ id: 'owner1', role: Role.OWNER });

  function makeDeps(employeeCompetencyFindMany: jest.Mock) {
    const prisma = { employeeCompetency: { findMany: employeeCompetencyFindMany } };
    const service = new AssistantToolsService({} as any, {} as any, {} as any, {} as any, prisma as any);
    return { service, prisma };
  }

  it('ни одного активного сотрудника с этой компетенцией — пустой список, не ошибка', async () => {
    const { service, prisma } = makeDeps(jest.fn().mockResolvedValue([]));

    const result = await service.execute('find_employee_by_competency', { competencyId: 'c1' }, owner);

    expect(result).toEqual({ tool: 'find_employee_by_competency', competencyId: 'c1', employees: [] });
    expect(prisma.employeeCompetency.findMany).toHaveBeenCalledWith({
      where: { competencyId: 'c1', employee: { status: 'ACTIVE' } },
      select: { employee: { select: { id: true, fullName: true } } },
    });
  });

  it('ровно один сотрудник — список из одного', async () => {
    const { service } = makeDeps(jest.fn().mockResolvedValue([{ employee: { id: 'e1', fullName: 'Жандос Ахметов' } }]));

    const result = await service.execute('find_employee_by_competency', { competencyId: 'c1' }, owner);

    expect(result).toEqual({ tool: 'find_employee_by_competency', competencyId: 'c1', employees: [{ id: 'e1', fullName: 'Жандос Ахметов' }] });
  });

  it('несколько сотрудников — полный список, backend НЕ выбирает за модель', async () => {
    const { service } = makeDeps(
      jest.fn().mockResolvedValue([
        { employee: { id: 'e1', fullName: 'Жандос Ахметов' } },
        { employee: { id: 'e2', fullName: 'Амир Жаксылыков' } },
      ]),
    );

    const result = await service.execute('find_employee_by_competency', { competencyId: 'c1' }, owner);

    expect(result).toMatchObject({
      employees: [
        { id: 'e1', fullName: 'Жандос Ахметов' },
        { id: 'e2', fullName: 'Амир Жаксылыков' },
      ],
    });
  });

  it('competencyId не передан — безопасная ошибка, БД не запрашивается', async () => {
    const { service, prisma } = makeDeps(jest.fn());

    const result = await service.execute('find_employee_by_competency', {}, owner);

    expect(result).toMatchObject({ tool: 'find_employee_by_competency', error: true });
    expect('message' in result && result.message).toContain('INVALID_INPUT');
    expect(prisma.employeeCompetency.findMany).not.toHaveBeenCalled();
  });
});

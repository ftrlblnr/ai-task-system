import { NotFoundException } from '@nestjs/common';
import { Role, TaskStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { buildTaskSearchWhere, TasksService } from '../tasks/tasks.service';
import { AssistantToolsService } from './assistant-tools.service';
import { buildAssistantParts, toolActivityLabel } from './assistant-render';
import {
  FIND_TASKS_DEFAULT_LIMIT,
  historyEmployeeIds,
  parseFindTasksInput,
  toFoundTask,
  toTaskDetail,
} from './task-tools';

// Единый агент A1 (docs/AGENT_AND_MEETINGS.md): поиск задач и задача
// целиком — разбор входа модели, фильтры, счётчики по всей выборке,
// резолв имён без доверия к модели.

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.OWNER, ...overrides };
}

const DAY = 24 * 60 * 60 * 1000;

describe('parseFindTasksInput', () => {
  it('пустой вход — открытые задачи, лимит по умолчанию', () => {
    expect(parseFindTasksInput(undefined)).toMatchObject({
      statuses: [],
      overdue: false,
      unassigned: false,
      limit: FIND_TASKS_DEFAULT_LIMIT,
    });
  });

  it('мусорные статусы и пустые строки отбрасываются, лимит — целое ≥ 1', () => {
    const parsed = parseFindTasksInput({
      status: ['DONE', 'OVERDUE', 5],
      query: '  ',
      assigneeRawText: ' Ирины ',
      limit: 7.9,
    });
    expect(parsed.statuses).toEqual([TaskStatus.DONE]);
    expect(parsed.query).toBeUndefined();
    expect(parsed.assigneeRawText).toBe('Ирины');
    expect(parsed.limit).toBe(7);
    expect(parseFindTasksInput({ limit: 0 }).limit).toBe(
      FIND_TASKS_DEFAULT_LIMIT,
    );
  });

  it('даты модели — местное время (+05:00), непонятная дата — без фильтра', () => {
    const parsed = parseFindTasksInput({
      dueFrom: '2026-11-02T00:00:00',
      dueTo: 'в пятницу',
    });
    expect(parsed.dueFrom?.toISOString()).toBe('2026-11-01T19:00:00.000Z');
    expect(parsed.dueTo).toBeUndefined();
  });
});

describe('buildTaskSearchWhere', () => {
  const now = new Date('2026-10-28T10:00:00Z');

  it('по умолчанию — открытые задачи верхнего уровня', () => {
    expect(buildTaskSearchWhere({ limit: 10 }, now)).toEqual({
      AND: [
        { parentTaskId: null },
        { status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] } },
      ],
    });
  });

  it('все фильтры попадают в where; null исполнителя — «без исполнителя»', () => {
    const where = buildTaskSearchWhere(
      {
        assigneeId: null,
        creatorId: 'c1',
        statuses: [TaskStatus.DONE],
        overdue: true,
        dueFrom: now,
        query: 'вентшахт',
        sourceMeetingId: 'm1',
        limit: 10,
      },
      now,
    );
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { status: { in: [TaskStatus.DONE] } },
        { assigneeId: null },
        { creatorId: 'c1' },
        {
          dueDate: { lt: now },
          status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] },
        },
        { dueDate: { gte: now } },
        {
          OR: [
            { title: { contains: 'вентшахт', mode: 'insensitive' } },
            { description: { contains: 'вентшахт', mode: 'insensitive' } },
          ],
        },
        { sourceMeetingId: 'm1' },
      ]),
    );
  });
});

describe('TasksService.search — счётчики по всей выборке, не по срезу', () => {
  function serviceWith() {
    const prisma = {
      task: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValueOnce(37).mockResolvedValueOnce(6),
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([
            { assigneeId: 'a', _count: { _all: 20 } },
            { assigneeId: 'b', _count: { _all: 12 } },
            { assigneeId: null, _count: { _all: 5 } },
          ])
          .mockResolvedValueOnce([{ assigneeId: 'b', _count: { _all: 6 } }])
          .mockResolvedValueOnce([
            { status: TaskStatus.IN_PROGRESS, _count: { _all: 30 } },
            { status: TaskStatus.NEW, _count: { _all: 7 } },
          ]),
      },
      employee: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', fullName: 'Ким Арман' },
          { id: 'b', fullName: 'Иванова Ирина' },
        ]),
      },
    };
    return { service: new TasksService(prisma as any, {} as any), prisma };
  }

  it('сначала тот, у кого больше просрочек; без исполнителя подписан; лимит не больше 30', async () => {
    const { service, prisma } = serviceWith();
    const result = await service.search({ limit: 500 });
    expect(result.totalCount).toBe(37);
    expect(result.overdueCount).toBe(6);
    expect(result.byAssignee).toEqual([
      { assigneeId: 'b', name: 'Иванова Ирина', count: 12, overdue: 6 },
      { assigneeId: 'a', name: 'Ким Арман', count: 20, overdue: 0 },
      { assigneeId: null, name: 'Без исполнителя', count: 5, overdue: 0 },
    ]);
    expect(result.byStatus[0]).toEqual({
      status: TaskStatus.IN_PROGRESS,
      count: 30,
    });
    expect(prisma.task.findMany.mock.calls[0][0].take).toBe(30);
  });
});

describe('toFoundTask / toTaskDetail', () => {
  const now = new Date('2026-10-28T10:00:00Z');
  const base = {
    id: 't1',
    title: 'Отчёт',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    dueDate: new Date(now.getTime() - 3 * DAY - 1000),
    isOverdue: true,
    assignee: { id: 'a', fullName: 'Ким Арман' },
    creator: { fullName: 'Руководитель' },
  };

  it('дни просрочки — полные сутки; не просрочена — null', () => {
    expect(toFoundTask(base, now).daysOverdue).toBe(3);
    expect(
      toFoundTask({ ...base, isOverdue: false }, now).daysOverdue,
    ).toBeNull();
  });

  it('история: id исполнителя → имя, только последние 10; комментарии — последние 10', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
      field: i === 0 ? 'assigneeId' : 'title',
      oldValue: i === 0 ? 'a' : 'x',
      newValue: i === 0 ? 'b' : 'y',
      createdAt: now,
      changedBy: { fullName: 'Руководитель' },
    }));
    const comments = Array.from({ length: 12 }, (_, i) => ({
      body: `к${i}`,
      createdAt: now,
      author: { fullName: 'Ким Арман' },
    }));
    expect(historyEmployeeIds(history)).toEqual(['a', 'b']);
    const detail = toTaskDetail(
      {
        ...base,
        description: null,
        sourceMeeting: null,
        sourceTimestamp: null,
        sourceContext: null,
        subtasks: [],
        history,
        comments,
      },
      new Map([
        ['a', 'Ким Арман'],
        ['b', 'Иванова Ирина'],
      ]),
      now,
    );
    expect(detail.history).toHaveLength(10);
    expect(detail.history[0]).toMatchObject({
      field: 'assigneeId',
      from: 'Ким Арман',
      to: 'Иванова Ирина',
    });
    expect(detail.comments.map((c) => c.text)).toEqual([
      'к2',
      'к3',
      'к4',
      'к5',
      'к6',
      'к7',
      'к8',
      'к9',
      'к10',
      'к11',
    ]);
    expect(detail.commentCount).toBe(12);
  });
});

describe('AssistantToolsService.execute find_tasks', () => {
  const emptySearch = {
    items: [],
    totalCount: 0,
    overdueCount: 0,
    byAssignee: [],
    byStatus: [],
  };

  function serviceWith(resolution: {
    status: 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND';
    employeeId: string | null;
  }) {
    const tasks = { search: jest.fn().mockResolvedValue(emptySearch) };
    const prisma = {
      employee: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'e2', fullName: 'Иванова Ирина' }]),
      },
    };
    const resolver = { resolve: jest.fn().mockResolvedValue(resolution) };
    const service = new AssistantToolsService(
      tasks as any,
      {} as any,
      {} as any,
      {} as any,
      prisma as any,
      {} as any,
      resolver as any,
    );
    return { service, tasks, resolver };
  }

  it('имя исполнителя резолвит сервер, в фильтр уходит id, модель видит полное имя', async () => {
    const { service, tasks, resolver } = serviceWith({
      status: 'RESOLVED',
      employeeId: 'e2',
    });
    const result = await service.execute(
      'find_tasks',
      { assigneeRawText: 'у Ирины', overdue: true },
      user(),
    );
    expect(resolver.resolve).toHaveBeenCalledWith('у Ирины', [
      { id: 'e2', fullName: 'Иванова Ирина' },
    ]);
    expect(tasks.search).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: 'e2', overdue: true }),
    );
    expect(result).toMatchObject({
      tool: 'find_tasks',
      filter: { assignee: 'Иванова Ирина', creator: null },
    });
  });

  it('неоднозначное имя — понятная модели ошибка, поиск не выполняется', async () => {
    const { service, tasks } = serviceWith({
      status: 'AMBIGUOUS',
      employeeId: null,
    });
    const result = await service.execute(
      'find_tasks',
      { assigneeRawText: 'Ирины' },
      user(),
    );
    expect(result).toMatchObject({ tool: 'find_tasks', error: true });
    expect('message' in result && result.message).toContain(
      'EMPLOYEE_AMBIGUOUS',
    );
    expect(tasks.search).not.toHaveBeenCalled();
  });

  it('mine — по текущему пользователю, без резолва и запроса сотрудников', async () => {
    const { service, tasks, resolver } = serviceWith({
      status: 'RESOLVED',
      employeeId: 'x',
    });
    await service.execute(
      'find_tasks',
      { mine: 'created', assigneeRawText: 'Ирины' },
      user({ id: 'me' }),
    );
    expect(tasks.search).toHaveBeenCalledWith(
      expect.objectContaining({ creatorId: 'me', assigneeId: 'x' }),
    );
    await service.execute(
      'find_tasks',
      { mine: 'assigned' },
      user({ id: 'me', role: Role.EMPLOYEE }),
    );
    expect(tasks.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ assigneeId: 'me' }),
    );
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
  });

  it('карточек в ленте — не больше 10, подпись — с числом и просрочкой', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      taskId: `t${i}`,
      title: `Задача ${i}`,
      status: 'NEW',
      dueDate: null,
      assignee: null,
      priority: 'MEDIUM',
      isOverdue: false,
      daysOverdue: null,
      creator: null,
    }));
    const result = {
      tool: 'find_tasks' as const,
      items,
      totalCount: 37,
      overdueCount: 6,
      byAssignee: [],
      byStatus: [],
      filter: { assignee: 'Иванова Ирина', creator: null },
    };
    const parts = buildAssistantParts({
      text: 'ок',
      toolCalls: [{ name: 'find_tasks', result, durationMs: 1 }],
    });
    expect(parts.filter((p) => p.type === 'TASK_CARD')).toHaveLength(10);
    expect(
      Object.keys(parts.find((p) => p.type === 'TASK_CARD')!.data as object),
    ).not.toContain('daysOverdue');
    expect(toolActivityLabel(result).label).toBe(
      'Нашёл задачи · Иванова Ирина: 37, просрочено 6',
    );
  });
});

describe('AssistantToolsService.execute get_task', () => {
  it('нет задачи — TASK_NOT_FOUND, а не общий сбой', async () => {
    const tasks = {
      findOne: jest
        .fn()
        .mockRejectedValue(new NotFoundException('Задача не найдена')),
    };
    const service = new AssistantToolsService(
      tasks as any,
      {} as any,
      {} as any,
    );
    const result = await service.execute(
      'get_task',
      { taskId: 'nope' },
      user(),
    );
    expect(result).toMatchObject({ tool: 'get_task', error: true });
    expect('message' in result && result.message).toContain('TASK_NOT_FOUND');
  });

  it('пустой id — INVALID_INPUT без запроса', async () => {
    const tasks = { findOne: jest.fn() };
    const service = new AssistantToolsService(
      tasks as any,
      {} as any,
      {} as any,
    );
    const result = await service.execute('get_task', { taskId: ' ' }, user());
    expect('message' in result && result.message).toContain('INVALID_INPUT');
    expect(tasks.findOne).not.toHaveBeenCalled();
  });
});

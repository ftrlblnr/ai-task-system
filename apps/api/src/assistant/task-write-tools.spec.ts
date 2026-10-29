import { ForbiddenException } from '@nestjs/common';
import { Prisma, Role, TaskStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { routineTools } from '../routines/routine-catalog';
import { UndoService } from './undo.service';
import {
  AssistantToolsService,
  isWriteTool,
  toolResultForModel,
} from './assistant-tools.service';
import { buildAssistantParts } from './assistant-render';
import {
  describeTaskChanges,
  formatDue,
  parseUpdateTaskInput,
  TASK_WRITE_TOOLS,
} from './task-tools';

// Единый агент A2 (docs/AGENT_AND_MEETINGS.md): изменение существующих задач
// из чата — через TasksService, ровно одно выполнение на ключ хода, снимок
// для отмены тем же POST /voice/undo.

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.OWNER, ...overrides };
}

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });
}

const due = (iso: string) => new Date(iso);

function taskDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: 'Отчёт по объекту',
    description: null,
    status: TaskStatus.IN_PROGRESS,
    priority: 'MEDIUM',
    dueDate: due('2026-10-25T13:00:00Z'),
    assignee: { id: 'a1', fullName: 'Ким Арман' },
    ...overrides,
  };
}

// Prisma-заглушка для AgentActionExecution с состоянием: create кидает P2002,
// если строка уже есть, — как настоящий unique(conversationId, dedupeKey).
function executionPrisma(existing: Record<string, unknown> | null = null) {
  let row = existing;
  return {
    agentActionExecution: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          if (row) return Promise.reject(p2002());
          row = {
            id: 'x1',
            status: 'CLAIMED',
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          return Promise.resolve(row);
        }),
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(row)),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          row = { ...row, ...data };
          return Promise.resolve(row);
        }),
    },
    undoRecord: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: { expiresAt: Date } }) =>
          Promise.resolve({ id: 'undo-1', expiresAt: data.expiresAt }),
        ),
    },
    employee: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'a2', fullName: 'Сейткали Асель' }]),
    },
    task: { findUnique: jest.fn() },
    get row() {
      return row;
    },
  };
}

function serviceWith(
  tasks: Record<string, jest.Mock>,
  prisma = executionPrisma(),
  resolution = { status: 'RESOLVED', employeeId: 'a2' },
) {
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const resolver = { resolve: jest.fn().mockResolvedValue(resolution) };
  const service = new AssistantToolsService(
    tasks as any,
    {} as any,
    {} as any,
    {} as any,
    prisma as any,
    audit as any,
    resolver as any,
  );
  return { service, prisma, audit, resolver };
}

describe('parseUpdateTaskInput / describeTaskChanges', () => {
  it('срок — местное время, «снять срок» и «снять исполнителя» — явные флаги', () => {
    expect(
      parseUpdateTaskInput({ taskId: 't1', dueDate: '2026-10-31T18:00:00' })
        .dueDate,
    ).toBe('2026-10-31T18:00:00+05:00');
    expect(
      parseUpdateTaskInput({
        taskId: 't1',
        clearDueDate: true,
        dueDate: '2026-10-31T18:00:00',
      }).dueDate,
    ).toBeNull();
    expect(parseUpdateTaskInput({ taskId: 't1' }).dueDate).toBeUndefined();
    expect(
      parseUpdateTaskInput({ taskId: 't1', unassign: true }).unassign,
    ).toBe(true);
    expect(
      parseUpdateTaskInput({ taskId: 't1', priority: 'URGENT' }).priority,
    ).toBeUndefined();
  });

  it('«было → стало» — только изменившиеся поля, срок по времени компании', () => {
    expect(formatDue(due('2026-10-25T13:00:00Z'))).toBe('25.10, 18:00');
    const changes = describeTaskChanges(
      taskDetail(),
      taskDetail({
        dueDate: due('2026-10-31T13:00:00Z'),
        assignee: { id: 'a2', fullName: 'Сейткали Асель' },
      }),
    );
    expect(changes).toEqual([
      { label: 'Срок', from: '25.10, 18:00', to: '31.10, 18:00' },
      { label: 'Исполнитель', from: 'Ким Арман', to: 'Сейткали Асель' },
    ]);
  });
});

describe('пишущие инструменты задач — регистрация', () => {
  it('все пишущие — в isWriteTool, регламенты их не получают', () => {
    for (const t of TASK_WRITE_TOOLS) expect(isWriteTool(t.name)).toBe(true);
    const tools = TASK_WRITE_TOOLS.map((t) => ({ ...t }));
    expect(routineTools(tools, isWriteTool, null, false)).toEqual([]);
  });

  it('выдаются всем ролям — права проверяет TasksService', async () => {
    const service = new AssistantToolsService({} as any, {} as any, {} as any);
    const names = (await service.buildTools(user({ role: Role.EMPLOYEE }))).map(
      (t) => t.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'update_task',
        'set_task_status',
        'comment_task',
        'remind_task',
        'delete_task',
      ]),
    );
    expect(names).not.toContain('create_task');
  });
});

describe('update_task', () => {
  it('исполнитель по имени, изменение через TasksService, снимок «до» для отмены, карточка с изменениями', async () => {
    const before = taskDetail();
    const after = taskDetail({
      dueDate: due('2026-10-31T13:00:00Z'),
      assignee: { id: 'a2', fullName: 'Сейткали Асель' },
    });
    const tasks = {
      findOne: jest.fn().mockResolvedValue(before),
      update: jest.fn().mockResolvedValue(after),
    };
    const { service, prisma, resolver } = serviceWith(tasks);

    const result = await service.execute(
      'update_task',
      {
        taskId: 't1',
        assigneeRawText: 'Асель',
        dueDate: '2026-10-31T18:00:00',
      },
      user(),
      'conv1',
      'msg1',
      0,
    );

    expect(resolver.resolve).toHaveBeenCalledWith('Асель', [
      { id: 'a2', fullName: 'Сейткали Асель' },
    ]);
    expect(tasks.update).toHaveBeenCalledWith(
      't1',
      { assigneeId: 'a2', dueDate: '2026-10-31T18:00:00+05:00' },
      expect.objectContaining({ id: 'u1' }),
    );
    expect(prisma.undoRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'TASK',
        action: 'UPDATE',
        entityId: 't1',
        conversationId: 'conv1',
        previous: { assigneeId: 'a1', dueDate: '2026-10-25T13:00:00.000Z' },
      }),
    });
    expect(result).toMatchObject({
      tool: 'update_task',
      task: {
        taskId: 't1',
        undoToken: 'undo-1',
        changes: [{ label: 'Срок' }, { label: 'Исполнитель' }],
      },
    });
    expect(prisma.agentActionExecution.create).toHaveBeenCalledWith({
      data: {
        conversationId: 'conv1',
        dedupeKey: 'msg1:0',
        tool: 'update_task',
      },
    });
    expect(prisma.row).toMatchObject({ status: 'COMPLETED' });

    const parts = buildAssistantParts({
      text: 'Готово',
      toolCalls: [{ name: 'update_task', result, durationMs: 1 }],
    });
    expect(parts.find((p) => p.type === 'TASK_CARD')?.data).toMatchObject({
      undoToken: 'undo-1',
    });
  });

  it('повтор хода с тем же ключом — сохранённый результат, задача не меняется второй раз', async () => {
    const stored = {
      tool: 'update_task',
      task: {
        taskId: 't1',
        title: 'Отчёт',
        status: 'NEW',
        dueDate: null,
        assignee: null,
      },
    };
    const prisma = executionPrisma({
      id: 'x1',
      status: 'COMPLETED',
      resultJson: stored,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const tasks = { findOne: jest.fn(), update: jest.fn() };
    const { service } = serviceWith(tasks, prisma);

    const result = await service.execute(
      'update_task',
      { taskId: 't1', priority: 'HIGH' },
      user(),
      'conv1',
      'msg1',
      0,
    );

    expect(result).toEqual(stored);
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('параллельный вызов (свежий CLAIMED) — отказ без изменения', async () => {
    const prisma = executionPrisma({
      id: 'x1',
      status: 'CLAIMED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const tasks = { findOne: jest.fn(), update: jest.fn() };
    const { service } = serviceWith(tasks, prisma);
    const result = await service.execute(
      'update_task',
      { taskId: 't1', priority: 'HIGH' },
      user(),
      'conv1',
      'msg1',
      0,
    );
    expect('message' in result && result.message).toContain(
      'ALREADY_PROCESSING',
    );
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('брошенный CLAIMED, изменение уже в базе — второй раз не применяем', async () => {
    const old = new Date(Date.now() - 5 * 60_000);
    const prisma = executionPrisma({
      id: 'x1',
      status: 'CLAIMED',
      createdAt: old,
      updatedAt: old,
    });
    prisma.task.findUnique.mockResolvedValue({
      title: 'Отчёт',
      description: null,
      assigneeId: 'a1',
      dueDate: null,
      priority: 'HIGH',
    });
    const tasks = { findOne: jest.fn(), update: jest.fn() };
    const { service } = serviceWith(tasks, prisma);

    const result = await service.execute(
      'update_task',
      { taskId: 't1', priority: 'HIGH' },
      user(),
      'conv1',
      'msg1',
      0,
    );

    expect(result).toEqual({
      tool: 'update_task',
      alreadyApplied: true,
      taskId: 't1',
    });
    expect(tasks.update).not.toHaveBeenCalled();
    expect(prisma.row).toMatchObject({ status: 'COMPLETED' });
  });

  it('нет прав — TASK_FORBIDDEN с текстом сервиса, выполнение помечено FAILED, отмены нет', async () => {
    const tasks = {
      findOne: jest.fn().mockResolvedValue(taskDetail()),
      update: jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException(
            'Редактировать задачу может только её постановщик или руководитель',
          ),
        ),
    };
    const { service, prisma } = serviceWith(tasks);
    const result = await service.execute(
      'update_task',
      { taskId: 't1', priority: 'HIGH' },
      user({ role: Role.EMPLOYEE }),
      'conv1',
      'msg1',
      0,
    );
    expect('message' in result && result.message).toBe(
      'TASK_FORBIDDEN: Редактировать задачу может только её постановщик или руководитель',
    );
    expect(prisma.row).toMatchObject({ status: 'FAILED' });
    expect(prisma.undoRecord.create).not.toHaveBeenCalled();
  });

  it('неоднозначный исполнитель — ничего не меняем и не занимаем ключ', async () => {
    const tasks = { findOne: jest.fn(), update: jest.fn() };
    const { service, prisma } = serviceWith(tasks, executionPrisma(), {
      status: 'AMBIGUOUS',
      employeeId: null,
    } as any);
    const result = await service.execute(
      'update_task',
      { taskId: 't1', assigneeRawText: 'Асель' },
      user(),
      'conv1',
      'msg1',
      0,
    );
    expect('message' in result && result.message).toContain(
      'ASSIGNEE_AMBIGUOUS',
    );
    expect(prisma.agentActionExecution.create).not.toHaveBeenCalled();
  });

  it('без ключа хода (вызов в обход runReply) — безопасный отказ', async () => {
    const tasks = { findOne: jest.fn(), update: jest.fn() };
    const { service } = serviceWith(tasks);
    const result = await service.execute(
      'update_task',
      { taskId: 't1', priority: 'HIGH' },
      user(),
    );
    expect(result).toMatchObject({ tool: 'update_task', error: true });
    expect(tasks.update).not.toHaveBeenCalled();
  });
});

describe('set_task_status / comment_task / delete_task', () => {
  it('смена статуса — снимок прежнего статуса для отмены', async () => {
    const tasks = {
      findOne: jest.fn().mockResolvedValue(taskDetail()),
      updateStatus: jest
        .fn()
        .mockResolvedValue(taskDetail({ status: TaskStatus.DONE })),
    };
    const { service, prisma } = serviceWith(tasks);
    const result = await service.execute(
      'set_task_status',
      { taskId: 't1', status: 'DONE' },
      user(),
      'conv1',
      'msg1',
      0,
    );
    expect(tasks.updateStatus).toHaveBeenCalledWith(
      't1',
      TaskStatus.DONE,
      expect.objectContaining({ id: 'u1' }),
    );
    expect(prisma.undoRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ previous: { status: 'IN_PROGRESS' } }),
    });
    expect(result).toMatchObject({
      task: {
        changes: [{ label: 'Статус', from: 'В работе', to: 'Выполнена' }],
      },
    });
  });

  it('тот же статус — ничего не меняем, модели — «уже так»', async () => {
    const tasks = {
      findOne: jest.fn().mockResolvedValue(taskDetail()),
      updateStatus: jest.fn(),
    };
    const { service } = serviceWith(tasks);
    const result = await service.execute(
      'set_task_status',
      { taskId: 't1', status: 'IN_PROGRESS' },
      user(),
      'conv1',
      'msg1',
      0,
    );
    expect(tasks.updateStatus).not.toHaveBeenCalled();
    expect(JSON.stringify(toolResultForModel(result))).toContain(
      'Ничего не изменилось',
    );
  });

  it('черновик из чата не ставится', async () => {
    const tasks = { findOne: jest.fn(), updateStatus: jest.fn() };
    const { service } = serviceWith(tasks);
    const result = await service.execute(
      'set_task_status',
      { taskId: 't1', status: 'DRAFT' },
      user(),
      'conv1',
      'msg1',
      0,
    );
    expect('message' in result && result.message).toContain('INVALID_INPUT');
  });

  it('комментарий — через TasksService.addComment от имени пользователя', async () => {
    const tasks = { addComment: jest.fn().mockResolvedValue(taskDetail()) };
    const { service } = serviceWith(tasks);
    const result = await service.execute(
      'comment_task',
      { taskId: 't1', text: ' Нужен новый срок ' },
      user(),
      'conv1',
      'msg1',
      0,
    );
    expect(tasks.addComment).toHaveBeenCalledWith(
      't1',
      { body: 'Нужен новый срок' },
      expect.objectContaining({ id: 'u1' }),
    );
    expect(result).toMatchObject({
      tool: 'comment_task',
      comment: 'Нужен новый срок',
    });
  });

  it('удаление — без отмены, карточки нет', async () => {
    const tasks = {
      findOne: jest.fn().mockResolvedValue(taskDetail()),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const { service, prisma } = serviceWith(tasks);
    const result = await service.execute(
      'delete_task',
      { taskId: 't1' },
      user(),
      'conv1',
      'msg1',
      0,
    );
    expect(tasks.remove).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ id: 'u1' }),
    );
    expect(result).toEqual({
      tool: 'delete_task',
      taskId: 't1',
      title: 'Отчёт по объекту',
    });
    expect(prisma.undoRecord.create).not.toHaveBeenCalled();
    expect(
      buildAssistantParts({
        text: 'Удалил',
        toolCalls: [{ name: 'delete_task', result, durationMs: 1 }],
      }).some((p) => p.type === 'TASK_CARD'),
    ).toBe(false);
  });
});

describe('UndoService.undo — отмена изменений из чата', () => {
  function undoPrisma(record: Record<string, unknown>) {
    let current = { ...record };
    return {
      undoRecord: {
        findUnique: jest.fn().mockResolvedValue(record),
        update: jest
          .fn()
          .mockImplementation(
            ({
              where,
              data,
            }: {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }) => {
              if (
                where.status !== undefined &&
                where.status !== current.status
              ) {
                return Promise.reject(
                  new Prisma.PrismaClientKnownRequestError('Record not found', {
                    code: 'P2025',
                    clientVersion: '6.19.3',
                  }),
                );
              }
              current = { ...current, ...data };
              return Promise.resolve(current);
            },
          ),
      },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'conv-card' }),
      },
      message: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  it('статус возвращается через updateStatus, update с пустым патчем не вызывается, «Отменено.» — в разговор карточки', async () => {
    const prisma = undoPrisma({
      id: 'undo-1',
      employeeId: 'u1',
      kind: 'TASK',
      action: 'UPDATE',
      entityId: 't1',
      previous: { status: 'IN_PROGRESS' },
      expiresAt: new Date(Date.now() + 30_000),
      status: 'AVAILABLE',
      conversationId: 'conv-card',
    });
    const tasks = {
      update: jest.fn(),
      updateStatus: jest.fn().mockResolvedValue({}),
    };
    const chat = { getOrCreatePrimaryConversation: jest.fn() };
    const service = new UndoService(
      prisma as any,
      tasks as any,
      {} as any,
      chat as any,
    ) as any;

    const result = await service.undo(
      { undoToken: 'undo-1' },
      user({ role: Role.EMPLOYEE }),
    );

    expect(result).toEqual({ ok: true, error: null, warning: null });
    expect(tasks.update).not.toHaveBeenCalled();
    expect(tasks.updateStatus).toHaveBeenCalledWith(
      't1',
      'IN_PROGRESS',
      expect.objectContaining({ id: 'u1' }),
    );
    expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'conv-card', employeeId: 'u1' },
      select: { id: true },
    });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ conversationId: 'conv-card' }),
      }),
    );
    expect(chat.getOrCreatePrimaryConversation).not.toHaveBeenCalled();
  });
});

describe('create_task — отмена новой задачи (A4)', () => {
  it('после создания — UndoRecord TASK/CREATE в разговор карточки, токен в карточке', async () => {
    const prisma = {
      ...executionPrisma(),
      taskFromMeetingExecution: {
        create: jest.fn().mockResolvedValue({ id: 'exec1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const tasks = {
      create: jest.fn().mockResolvedValue({
        id: 't9',
        title: 'Сходить в банк',
        status: 'NEW',
        dueDate: null,
        assignee: null,
      }),
    };
    const { service } = serviceWith(tasks, prisma);
    const result = await service.execute(
      'create_task',
      { title: 'Сходить в банк' },
      user(),
      'conv1',
      'msg1',
      0,
    );
    expect(prisma.undoRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'TASK',
        action: 'CREATE',
        entityId: 't9',
        conversationId: 'conv1',
      }),
    });
    expect(result).toMatchObject({
      tool: 'create_task',
      task: { taskId: 't9', undoToken: 'undo-1' },
    });
  });
});

import { ForbiddenException } from '@nestjs/common';
import { Role, TaskStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { EMPLOYEE_ALLOWED_STATUSES, isTaskOverdue, TasksService } from './tasks.service';

// isTaskOverdue — чистая функция (аудит 10.09.2026, п. 5.1: "чистые
// функции — тестировать легко"); сервис — на заглушках prisma/bot.
function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, ...overrides };
}

// Ролевая модель 20.10.2026: задачи видят все, но переставлять чужие на
// канбане может только руководитель/администратор.
describe('TasksService.reorder (граница прав)', () => {
  function serviceWith(tasks: { id: string; creatorId: string; assigneeId: string | null }[]) {
    const prisma = {
      task: { findMany: jest.fn().mockResolvedValue(tasks), update: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    return { service: new TasksService(prisma as any, {} as any), prisma };
  }

  it('администратор переставляет любые задачи', async () => {
    const { service, prisma } = serviceWith([{ id: 't1', creatorId: 'x', assigneeId: 'y' }]);
    await service.reorder(['t1'], user({ role: Role.ADMIN }));
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('пользователь переставляет свою задачу (исполнитель или постановщик)', async () => {
    const { service, prisma } = serviceWith([
      { id: 't1', creatorId: 'u1', assigneeId: 'y' },
      { id: 't2', creatorId: 'x', assigneeId: 'u1' },
    ]);
    await service.reorder(['t1', 't2'], user());
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('пользователь не может переставить чужую задачу', async () => {
    const { service, prisma } = serviceWith([{ id: 't1', creatorId: 'x', assigneeId: 'y' }]);
    await expect(service.reorder(['t1'], user())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('EMPLOYEE_ALLOWED_STATUSES (раздел 10 ТЗ — значимые решения не отдаются в автономию)', () => {
  it('содержит только рабочие переходы, не возврат/отмену', () => {
    expect(EMPLOYEE_ALLOWED_STATUSES).toEqual([TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.DONE]);
  });

  it('не включает RETURNED/CANCELLED (решение руководителя, не исполнителя)', () => {
    expect(EMPLOYEE_ALLOWED_STATUSES).not.toContain(TaskStatus.RETURNED);
    expect(EMPLOYEE_ALLOWED_STATUSES).not.toContain(TaskStatus.CANCELLED);
  });
});

describe('isTaskOverdue (аудит 10.09.2026, п. 2.1 — вычисляемый признак вместо хранимого статуса)', () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

  it('без срока — не просрочена', () => {
    expect(isTaskOverdue({ dueDate: null, status: TaskStatus.NEW })).toBe(false);
  });

  it('срок в прошлом и задача ещё не закрыта — просрочена', () => {
    expect(isTaskOverdue({ dueDate: past, status: TaskStatus.IN_PROGRESS })).toBe(true);
  });

  it('срок в прошлом, но задача выполнена — не просрочена', () => {
    expect(isTaskOverdue({ dueDate: past, status: TaskStatus.DONE })).toBe(false);
  });

  it('срок в прошлом, но задача отменена — не просрочена', () => {
    expect(isTaskOverdue({ dueDate: past, status: TaskStatus.CANCELLED })).toBe(false);
  });

  it('срок в будущем — не просрочена', () => {
    expect(isTaskOverdue({ dueDate: future, status: TaskStatus.NEW })).toBe(false);
  });
});

// Hardening-раунд Phase O (22.09.2026, P1 "source integrity") — раньше
// эти инварианты проверял только create_task_from_meeting (caller), не
// сам domain service. Другой/будущий caller, не повторивший ту же
// проверку, мог передать sourceSegmentId без sourceMeetingId, либо
// sourceSegmentId из СОВСЕМ ДРУГОЙ встречи.
describe('TasksService.create — source integrity (hardening 22.09.2026, P1)', () => {
  const owner: AuthenticatedUser = { id: 'owner1', email: 'o@example.com', role: Role.OWNER };
  const employee: AuthenticatedUser = user();

  function makeDeps() {
    const prisma = {
      task: { create: jest.fn().mockResolvedValue({ id: 't1', assigneeId: null, dueDate: null, title: 'T', watchers: [], subtasks: [] }) },
      meetingSegment: { findUnique: jest.fn() },
    };
    const service = new TasksService(prisma as any, {} as any);
    return { service, prisma };
  }

  it('sourceSegmentId без sourceMeetingId — BadRequestException, prisma.task.create не вызывается', async () => {
    const { service, prisma } = makeDeps();

    await expect(service.create({ title: 'T', sourceSegmentId: 's1' } as any, owner)).rejects.toThrow('sourceSegmentId указан без sourceMeetingId');
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  it('sourceSegmentId из ДРУГОЙ встречи (не совпадает с sourceMeetingId) — BadRequestException', async () => {
    const { service, prisma } = makeDeps();
    prisma.meetingSegment.findUnique.mockResolvedValue({ meetingId: 'm-other' });

    await expect(service.create({ title: 'T', sourceMeetingId: 'm1', sourceSegmentId: 's1' } as any, owner)).rejects.toThrow(
      'sourceSegmentId не принадлежит указанной встрече',
    );
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  it('sourceSegmentId ссылается на несуществующий сегмент — BadRequestException', async () => {
    const { service, prisma } = makeDeps();
    prisma.meetingSegment.findUnique.mockResolvedValue(null);

    await expect(service.create({ title: 'T', sourceMeetingId: 'm1', sourceSegmentId: 'ghost' } as any, owner)).rejects.toThrow(
      'sourceSegmentId не принадлежит указанной встрече',
    );
  });

  it('валидная пара sourceMeetingId/sourceSegmentId (сегмент реально принадлежит этой встрече) — проходит, sourceExecutionId тоже сохраняется', async () => {
    const { service, prisma } = makeDeps();
    prisma.meetingSegment.findUnique.mockResolvedValue({ meetingId: 'm1' });

    await service.create({ title: 'T', sourceMeetingId: 'm1', sourceSegmentId: 's1', sourceExecutionId: 'exec1' } as any, owner);

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceMeetingId: 'm1', sourceSegmentId: 's1', sourceExecutionId: 'exec1' }) }),
    );
  });

  it('без sourceSegmentId — проверка сегмента вообще не выполняется (обычная ручная постановка)', async () => {
    const { service, prisma } = makeDeps();

    await service.create({ title: 'T' } as any, owner);

    expect(prisma.meetingSegment.findUnique).not.toHaveBeenCalled();
    expect(prisma.task.create).toHaveBeenCalled();
  });

  it('sourceSegmentId от сотрудника (не OWNER) — ForbiddenException, до проверки сегмента', async () => {
    const { service, prisma } = makeDeps();

    await expect(service.create({ title: 'T', sourceMeetingId: 'm1', sourceSegmentId: 's1' } as any, employee)).rejects.toThrow(
      'Задачи из встречи может ставить только руководитель',
    );
    expect(prisma.meetingSegment.findUnique).not.toHaveBeenCalled();
  });

  it('sourceExecutionId от сотрудника (не OWNER), без sourceMeetingId/sourceSegmentId — тоже ForbiddenException', async () => {
    const { service } = makeDeps();

    await expect(service.create({ title: 'T', sourceExecutionId: 'exec1' } as any, employee)).rejects.toThrow(
      'Задачи из встречи может ставить только руководитель',
    );
  });
});

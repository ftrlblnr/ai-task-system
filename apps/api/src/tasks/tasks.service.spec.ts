import { ForbiddenException } from '@nestjs/common';
import { Role, TaskStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { EMPLOYEE_ALLOWED_STATUSES, isTaskOverdue, TasksService } from './tasks.service';

// assertVisible/isTaskOverdue не трогают this.prisma/this.bot — зависимости
// заглушены, тестируем только саму границу видимости и признак просрочки
// (аудит 10.09.2026, п. 5.1: "чистые функции — тестировать легко").
function makeService(): TasksService {
  return new TasksService({} as any, {} as any);
}

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, isProfileAdmin: false, ...overrides };
}

describe('TasksService.assertVisible (RBAC-граница видимости задачи)', () => {
  const service = makeService() as any;

  it('руководитель видит любую задачу', () => {
    expect(() => service.assertVisible({ assigneeId: 'someone-else', creatorId: 'someone-else' }, user({ role: Role.OWNER }))).not.toThrow();
  });

  it('исполнитель видит задачу, назначенную на него', () => {
    expect(() => service.assertVisible({ assigneeId: 'u1', creatorId: 'other' }, user())).not.toThrow();
  });

  it('постановщик видит поставленную им задачу', () => {
    expect(() => service.assertVisible({ assigneeId: 'other', creatorId: 'u1' }, user())).not.toThrow();
  });

  it('посторонний сотрудник (ни исполнитель, ни постановщик) не видит задачу', () => {
    expect(() => service.assertVisible({ assigneeId: 'other', creatorId: 'other2' }, user())).toThrow(ForbiddenException);
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

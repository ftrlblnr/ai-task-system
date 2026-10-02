import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ActiveEmployeeGuard } from './active-employee.guard';

function contextWithUser(user: { id: string; role: string; isProfileAdmin: boolean }): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('ActiveEmployeeGuard', () => {
  it('сотрудник не найден — 401, не подтверждаем молчаливый отказ по-другому коду', async () => {
    const prisma = { employee: { findUnique: jest.fn().mockResolvedValue(null) } };
    const guard = new ActiveEmployeeGuard(prisma as any);

    await expect(guard.canActivate(contextWithUser({ id: 'e1', role: 'EMPLOYEE', isProfileAdmin: false }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('сотрудник INACTIVE (уволен/заблокирован) — 401 даже с валидным JWT', async () => {
    const prisma = { employee: { findUnique: jest.fn().mockResolvedValue({ status: 'INACTIVE', role: 'EMPLOYEE', isProfileAdmin: false }) } };
    const guard = new ActiveEmployeeGuard(prisma as any);

    await expect(guard.canActivate(contextWithUser({ id: 'e1', role: 'EMPLOYEE', isProfileAdmin: false }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('роль в JWT устарела (была EMPLOYEE, в БД уже OWNER) — request.user.role перезаписывается живым значением', async () => {
    const prisma = { employee: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', role: 'OWNER', isProfileAdmin: true }) } };
    const guard = new ActiveEmployeeGuard(prisma as any);
    const request = { user: { id: 'e1', role: 'EMPLOYEE', isProfileAdmin: false } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user.role).toBe('OWNER');
    expect(request.user.isProfileAdmin).toBe(true);
  });

  it('активный сотрудник — пропускает без изменений (кроме синхронизации роли)', async () => {
    const prisma = { employee: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE', role: 'EMPLOYEE', isProfileAdmin: false }) } };
    const guard = new ActiveEmployeeGuard(prisma as any);

    await expect(guard.canActivate(contextWithUser({ id: 'e1', role: 'EMPLOYEE', isProfileAdmin: false }))).resolves.toBe(true);
  });
});

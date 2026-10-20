import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { assertOwnIntegration, DataOwnerGuard } from './data-owner';

function context(request: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function setup() {
  const prisma = { employee: { findFirst: jest.fn().mockResolvedValue({ id: 'leader' }) } };
  const audit = { log: jest.fn() };
  return { guard: new DataOwnerGuard(prisma as never, audit as never), prisma, audit };
}

describe('DataOwnerGuard (режим «за руководителя»)', () => {
  it('без заголовка — данные самого пользователя', async () => {
    const { guard } = setup();
    const request: any = { headers: {}, method: 'GET', user: { id: 'admin', role: 'ADMIN' } };
    await guard.canActivate(context(request));
    expect(request.dataOwner).toEqual({ id: 'admin', actingAsLeader: false });
  });

  it('администратор с X-Act-As: leader — данные руководителя, чтение без аудита', async () => {
    const { guard, audit } = setup();
    const request: any = { headers: { 'x-act-as': 'leader' }, method: 'GET', user: { id: 'admin', role: 'ADMIN' } };
    await guard.canActivate(context(request));
    expect(request.dataOwner).toEqual({ id: 'leader', actingAsLeader: true });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('изменение за руководителя пишется в аудит', async () => {
    const { guard, audit } = setup();
    const request: any = { headers: { 'x-act-as': 'leader' }, method: 'POST', originalUrl: '/calendar/events', user: { id: 'admin', role: 'ADMIN' } };
    await guard.canActivate(context(request));
    expect(audit.log).toHaveBeenCalledWith('admin', 'ACT_AS_LEADER', 'Employee', 'leader', { method: 'POST', path: '/calendar/events' });
  });

  it('пользователь с заголовком — заголовок игнорируется', async () => {
    const { guard, prisma } = setup();
    const request: any = { headers: { 'x-act-as': 'leader' }, method: 'GET', user: { id: 'emp', role: 'EMPLOYEE' } };
    await guard.canActivate(context(request));
    expect(request.dataOwner).toEqual({ id: 'emp', actingAsLeader: false });
    expect(prisma.employee.findFirst).not.toHaveBeenCalled();
  });

  it('подключать/отключать интеграции руководителя нельзя', () => {
    expect(() => assertOwnIntegration({ id: 'leader', actingAsLeader: true })).toThrow(ForbiddenException);
    expect(() => assertOwnIntegration({ id: 'admin', actingAsLeader: false })).not.toThrow();
  });
});

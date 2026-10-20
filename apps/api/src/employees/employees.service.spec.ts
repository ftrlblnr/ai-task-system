import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { EmployeesService } from './employees.service';

// Ролевая модель 20.10.2026: руководитель один, администраторов назначает
// только она, её учётку администратор не трогает.
const OWNER: AuthenticatedUser = { id: 'owner', email: 'o@x.kz', role: Role.OWNER };
const ADMIN: AuthenticatedUser = { id: 'admin', email: 'a@x.kz', role: Role.ADMIN };

function setup(targetRole: Role) {
  const prisma = {
    employee: {
      findUnique: jest.fn().mockResolvedValue({ id: 'target', role: targetRole }),
      update: jest.fn().mockResolvedValue({ id: 'target' }),
      create: jest.fn().mockResolvedValue({ id: 'new' }),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  return { service: new EmployeesService(prisma as never), prisma };
}

describe('EmployeesService — права ролей', () => {
  it('руководитель назначает администратора', async () => {
    const { service, prisma } = setup(Role.EMPLOYEE);
    await service.update('target', { role: Role.ADMIN }, OWNER);
    expect(prisma.employee.update).toHaveBeenCalled();
  });

  it('администратор не может назначить администратора', async () => {
    const { service, prisma } = setup(Role.EMPLOYEE);
    await expect(service.update('target', { role: Role.ADMIN }, ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it('второго руководителя назначить нельзя никому', async () => {
    const { service } = setup(Role.EMPLOYEE);
    await expect(service.update('target', { role: Role.OWNER }, OWNER)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('администратор не меняет учётку руководителя', async () => {
    const { service, prisma } = setup(Role.OWNER);
    await expect(service.update('target', { email: 'x@x.kz' }, ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it('администратор не снимает роль с другого администратора', async () => {
    const { service } = setup(Role.ADMIN);
    await expect(service.update('target', { role: Role.EMPLOYEE }, ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('администратор правит пользователя', async () => {
    const { service, prisma } = setup(Role.EMPLOYEE);
    await service.update('target', { fullName: 'Иван' }, ADMIN);
    expect(prisma.employee.update).toHaveBeenCalled();
  });

  it('администратор заводит пользователя, но не администратора', async () => {
    const { service, prisma } = setup(Role.EMPLOYEE);
    const dto = { fullName: 'Иван', email: 'i@x.kz', password: '12345678' };
    await service.create({ ...dto, role: Role.EMPLOYEE }, ADMIN);
    expect(prisma.employee.create).toHaveBeenCalled();
    await expect(service.create({ ...dto, role: Role.ADMIN }, ADMIN)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

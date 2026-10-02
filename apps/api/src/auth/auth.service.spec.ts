/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma */
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

interface EmployeeRow {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  status: 'ACTIVE' | 'INACTIVE';
  role: Role;
  isProfileAdmin: boolean;
  positionId: string | null;
  directionId: string | null;
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '6.19.3' });
}

function p2003(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', { code: 'P2003', clientVersion: '6.19.3' });
}

class FakePrisma {
  employees: EmployeeRow[] = [];
  window: { id: string; isOpen: boolean } | null = null;
  seq = 0;

  employee = {
    findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
      if (where.email) return this.employees.find((e) => e.email === where.email) ?? null;
      return this.employees.find((e) => e.id === where.id) ?? null;
    },
    create: async ({ data }: { data: Omit<EmployeeRow, 'id'> & { positionId?: string; directionId?: string } }) => {
      if (this.employees.some((e) => e.email === data.email)) throw p2002();
      if (data.positionId === 'missing' || data.directionId === 'missing') throw p2003();
      const row: EmployeeRow = {
        id: `e${++this.seq}`,
        positionId: null,
        directionId: null,
        ...data,
      };
      this.employees.push(row);
      return row;
    },
  };

  registrationWindow = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      return this.window?.id === where.id ? this.window : null;
    },
    upsert: async ({ where, create, update }: { where: { id: string }; create: { id: string; isOpen: boolean }; update: { isOpen: boolean } }) => {
      if (this.window?.id === where.id) {
        this.window = { ...this.window, ...update };
      } else {
        this.window = { ...create };
      }
      return this.window;
    },
  };
}

function buildService(prisma: FakePrisma) {
  const jwt = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };
  const config = { get: jest.fn() };
  return new AuthService(prisma as any, jwt as any, config as any);
}

describe('AuthService', () => {
  describe('validateCredentials / login', () => {
    it('верный логин/пароль у ACTIVE сотрудника — возвращает сотрудника', async () => {
      const prisma = new FakePrisma();
      const passwordHash = await bcrypt.hash('password123', 4);
      prisma.employees.push({
        id: 'e1', fullName: 'Иван', email: 'ivan@x.kz', passwordHash, status: 'ACTIVE',
        role: Role.EMPLOYEE, isProfileAdmin: false, positionId: null, directionId: null,
      });
      const service = buildService(prisma);

      const result = await service.validateCredentials('ivan@x.kz', 'password123');
      expect(result?.id).toBe('e1');
    });

    it('неверный пароль — null, не бросает', async () => {
      const prisma = new FakePrisma();
      const passwordHash = await bcrypt.hash('password123', 4);
      prisma.employees.push({
        id: 'e1', fullName: 'Иван', email: 'ivan@x.kz', passwordHash, status: 'ACTIVE',
        role: Role.EMPLOYEE, isProfileAdmin: false, positionId: null, directionId: null,
      });
      const service = buildService(prisma);

      expect(await service.validateCredentials('ivan@x.kz', 'wrong')).toBeNull();
    });

    it('неактивный сотрудник — null даже с верным паролем', async () => {
      const prisma = new FakePrisma();
      const passwordHash = await bcrypt.hash('password123', 4);
      prisma.employees.push({
        id: 'e1', fullName: 'Иван', email: 'ivan@x.kz', passwordHash, status: 'INACTIVE',
        role: Role.EMPLOYEE, isProfileAdmin: false, positionId: null, directionId: null,
      });
      const service = buildService(prisma);

      expect(await service.validateCredentials('ivan@x.kz', 'password123')).toBeNull();
    });

    it('login() с неверными данными — UnauthorizedException', async () => {
      const prisma = new FakePrisma();
      const service = buildService(prisma);
      await expect(service.login('nobody@x.kz', 'whatever1')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('registration window + register (владелец 02.10.2026)', () => {
    it('окно по умолчанию закрыто (строки ещё нет в базе)', async () => {
      const prisma = new FakePrisma();
      const service = buildService(prisma);
      expect(await service.getRegistrationWindow()).toEqual({ isOpen: false });
    });

    it('setRegistrationWindow открывает/закрывает и getRegistrationWindow видит изменение', async () => {
      const prisma = new FakePrisma();
      const service = buildService(prisma);

      expect(await service.setRegistrationWindow(true)).toEqual({ isOpen: true });
      expect(await service.getRegistrationWindow()).toEqual({ isOpen: true });

      expect(await service.setRegistrationWindow(false)).toEqual({ isOpen: false });
      expect(await service.getRegistrationWindow()).toEqual({ isOpen: false });
    });

    it('register() при закрытом окне — UnauthorizedException, сотрудник не создаётся', async () => {
      const prisma = new FakePrisma();
      const service = buildService(prisma);

      await expect(service.register('newlogin', 'password123', 'Новый Сотрудник')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.employees).toHaveLength(0);
    });

    it('register() при открытом окне — создаёт сотрудника с ролью EMPLOYEE независимо ни от чего', async () => {
      const prisma = new FakePrisma();
      const service = buildService(prisma);
      await service.setRegistrationWindow(true);

      const result = await service.register('newlogin', 'password123', 'Новый Сотрудник', 'pos1', 'dir1');

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user.email).toBe('newlogin');
      expect(prisma.employees[0].role).toBe(Role.EMPLOYEE);
      expect(prisma.employees[0].isProfileAdmin).toBe(false);
      expect(prisma.employees[0].positionId).toBe('pos1');
      expect(prisma.employees[0].directionId).toBe('dir1');
    });

    it('register() с уже занятым логином — ConflictException', async () => {
      const prisma = new FakePrisma();
      const service = buildService(prisma);
      await service.setRegistrationWindow(true);
      await service.register('taken', 'password123', 'Первый');

      await expect(service.register('taken', 'password456', 'Второй')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.employees).toHaveLength(1);
    });

    it('register() с несуществующей должностью/направлением — не роняет сервер 500ой, а BadRequestException', async () => {
      const prisma = new FakePrisma();
      const service = buildService(prisma);
      await service.setRegistrationWindow(true);

      await expect(service.register('x', 'password123', 'Кто-то', 'missing')).rejects.toMatchObject({ status: 400 });
    });
  });
});

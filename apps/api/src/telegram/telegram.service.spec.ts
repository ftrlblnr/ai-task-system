/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma */
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { verifyTelegramInitData } from './telegram-init-data';

jest.mock('./telegram-init-data', () => ({
  ...jest.requireActual('./telegram-init-data'),
  verifyTelegramInitData: jest.fn(),
}));

const mockedVerify = verifyTelegramInitData as jest.Mock;

interface EmployeeRow {
  id: string;
  fullName: string;
  email: string;
  telegramId: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  role: 'OWNER' | 'EMPLOYEE';
  isProfileAdmin: boolean;
}

class FakePrisma {
  employees: EmployeeRow[] = [];
  invites: { id: string; employeeId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null }[] = [];

  employee = {
    findUnique: async ({ where }: { where: { telegramId?: string; id?: string } }) => {
      if (where.telegramId !== undefined) return this.employees.find((e) => e.telegramId === where.telegramId) ?? null;
      return this.employees.find((e) => e.id === where.id) ?? null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<EmployeeRow> }) => {
      const row = this.employees.find((e) => e.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  };

  telegramInvite = {
    findUnique: async ({ where }: { where: { tokenHash: string } }) => {
      return this.invites.find((i) => i.tokenHash === where.tokenHash) ?? null;
    },
    update: async ({ where, data }: { where: { id: string }; data: { usedAt: Date } }) => {
      const row = this.invites.find((i) => i.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  };

  $transaction = async (ops: Promise<unknown>[]) => Promise.all(ops);
}

function buildService(prisma: FakePrisma, validateCredentials: jest.Mock) {
  const config = { get: jest.fn((key: string) => (key === 'TELEGRAM_BOT_TOKEN' ? 'test-bot-token' : undefined)) };
  const authService = { validateCredentials };
  return new TelegramService(prisma as any, config as any, authService as any);
}

describe('TelegramService.authenticate', () => {
  beforeEach(() => mockedVerify.mockReset());

  it('telegramId уже привязан — обычный вход, credentials не нужны', async () => {
    const prisma = new FakePrisma();
    prisma.employees.push({ id: 'e1', fullName: 'Иван', email: 'ivan@x.kz', telegramId: '1', status: 'ACTIVE', role: 'EMPLOYEE', isProfileAdmin: false });
    mockedVerify.mockReturnValue({ user: { id: 1 }, authDate: Date.now() / 1000 });
    const service = buildService(prisma, jest.fn());

    const employee = await service.authenticate('raw');
    expect(employee.id).toBe('e1');
  });

  it('telegramId не привязан, credentials не переданы — NO_EMPLOYEE_LINKED', async () => {
    const prisma = new FakePrisma();
    mockedVerify.mockReturnValue({ user: { id: 999 }, authDate: Date.now() / 1000 });
    const service = buildService(prisma, jest.fn());

    await expect(service.authenticate('raw')).rejects.toMatchObject({ message: expect.stringContaining('NO_EMPLOYEE_LINKED') });
  });

  it('telegramId не привязан, верные credentials — привязывает telegramId и возвращает сотрудника (владелец 02.10.2026)', async () => {
    const prisma = new FakePrisma();
    prisma.employees.push({ id: 'e1', fullName: 'Иван', email: 'ivan@x.kz', telegramId: null, status: 'ACTIVE', role: 'EMPLOYEE', isProfileAdmin: false });
    mockedVerify.mockReturnValue({ user: { id: 555 }, authDate: Date.now() / 1000 });
    const validateCredentials = jest.fn().mockResolvedValue({ id: 'e1' });
    const service = buildService(prisma, validateCredentials);

    const employee = await service.authenticate('raw', { login: 'ivan@x.kz', password: 'pass1234' });

    expect(validateCredentials).toHaveBeenCalledWith('ivan@x.kz', 'pass1234');
    expect(employee.id).toBe('e1');
    expect(prisma.employees[0].telegramId).toBe('555');
  });

  it('telegramId не привязан, неверные credentials — UnauthorizedException, ничего не привязывается', async () => {
    const prisma = new FakePrisma();
    prisma.employees.push({ id: 'e1', fullName: 'Иван', email: 'ivan@x.kz', telegramId: null, status: 'ACTIVE', role: 'EMPLOYEE', isProfileAdmin: false });
    mockedVerify.mockReturnValue({ user: { id: 555 }, authDate: Date.now() / 1000 });
    const validateCredentials = jest.fn().mockResolvedValue(null);
    const service = buildService(prisma, validateCredentials);

    await expect(service.authenticate('raw', { login: 'ivan@x.kz', password: 'wrong' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.employees[0].telegramId).toBeNull();
  });

  // Не воспроизводимо через публичный authenticate(): findByTelegramId уже
  // возвращает e2 напрямую, если telegramId занят — до credentials дело не
  // доходит. ensureTelegramFree — защита от TOCTOU-гонки между этим чтением
  // и update() (тот же паттерн, что уже был у consumeInvite до рефакторинга,
  // тоже никогда не тестировался отдельно) — проверяем её напрямую.
  it('ensureTelegramFree — ConflictException, если telegramId уже принадлежит другому сотруднику', async () => {
    const prisma = new FakePrisma();
    prisma.employees.push({ id: 'e2', fullName: 'Пётр', email: 'petr@x.kz', telegramId: '555', status: 'ACTIVE', role: 'EMPLOYEE', isProfileAdmin: false });
    const service = buildService(prisma, jest.fn()) as any;

    await expect(service.ensureTelegramFree('555', 'e1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('привязанный, но INACTIVE сотрудник — UnauthorizedException', async () => {
    const prisma = new FakePrisma();
    prisma.employees.push({ id: 'e1', fullName: 'Иван', email: 'ivan@x.kz', telegramId: '1', status: 'INACTIVE', role: 'EMPLOYEE', isProfileAdmin: false });
    mockedVerify.mockReturnValue({ user: { id: 1 }, authDate: Date.now() / 1000 });
    const service = buildService(prisma, jest.fn());

    await expect(service.authenticate('raw')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

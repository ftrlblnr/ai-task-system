import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Employee, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

interface TokenSubject {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  isProfileAdmin: boolean;
}

// Тот же SALT_ROUNDS, что в employees.service.ts (bcrypt.hash при создании
// сотрудника) — единая стоимость хэширования пароля во всей системе.
const SALT_ROUNDS = 12;

// Тот же token/hash/TTL паттерн, что у TelegramInvite/TelegramService
// (createInvite/consumeInvite) — не отдельное изобретение для пароля,
// владелец 08.09.2026: раньше единственный путь восстановить пароль был
// прямым вмешательством в БД.
const RESET_TTL_MINUTES = 30;

// Та же singleton-строка с фиксированным id, что ReceptionQueue (владелец
// 02.10.2026) — единственная запись в MVP, bootstrap через upsert по PK.
const REGISTRATION_WINDOW_ID = 'default';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const employee = await this.validateCredentials(email, password);
    if (!employee) {
      throw new UnauthorizedException('Неверный email или пароль');
    }
    return this.issueTokenFor(employee);
  }

  // Общая проверка логин+пароль — используется и обычным входом (login), и
  // привязкой Telegram через пароль внутри самостоятельной регистрации (см.
  // TelegramService.authenticate), чтобы не дублировать bcrypt.compare и
  // проверку status в двух местах. Возвращает null вместо throw — вызывающая
  // сторона формулирует сообщение об ошибке под свой контекст (обычный вход
  // vs привязка Telegram).
  async validateCredentials(email: string, password: string) {
    const employee = await this.prisma.employee.findUnique({ where: { email } });
    if (!employee || employee.status !== 'ACTIVE') return null;

    const passwordValid = await bcrypt.compare(password, employee.passwordHash);
    if (!passwordValid) return null;

    return employee;
  }

  // Владелец 02.10.2026: временное окно, когда человек сам заводит логин
  // (любая строка, не обязательно похожая на email — поле нигде не
  // используется для отправки писем) и пароль, минуя приглашение
  // руководителя. Публичный эндпоинт — но ничего не создаёт, пока окно не
  // открыто явным переключателем на странице «Сотрудники».
  async getRegistrationWindow() {
    const window = await this.prisma.registrationWindow.findUnique({ where: { id: REGISTRATION_WINDOW_ID } });
    return { isOpen: window?.isOpen ?? false };
  }

  async setRegistrationWindow(isOpen: boolean) {
    const window = await this.prisma.registrationWindow.upsert({
      where: { id: REGISTRATION_WINDOW_ID },
      create: { id: REGISTRATION_WINDOW_ID, isOpen },
      update: { isOpen },
    });
    return { isOpen: window.isOpen };
  }

  async register(login: string, password: string, fullName: string, positionId?: string, directionId?: string) {
    const window = await this.getRegistrationWindow();
    if (!window.isOpen) {
      throw new UnauthorizedException('Самостоятельная регистрация сейчас закрыта — обратитесь к руководителю');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    // Тип указан явно (тот же паттерн, что verified в telegram.service.ts,
    // аудит 10.09.2026, п. 5.2) — `let employee;` без аннотации и без
    // инициализатора TS выводит как any, из-за чего .id/.role ниже проходили
    // бы мимо @typescript-eslint/no-unsafe-* незамеченными.
    let employee: Employee;
    try {
      employee = await this.prisma.employee.create({
        data: {
          fullName,
          email: login,
          passwordHash,
          positionId: positionId || undefined,
          directionId: directionId || undefined,
          // Роль всегда EMPLOYEE — самостоятельная регистрация не даёт
          // прав руководителя ни при каких условиях, значение из запроса
          // клиента сюда никогда не попадает (его там и нет в DTO).
          role: Role.EMPLOYEE,
          isProfileAdmin: false,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') throw new ConflictException('Этот логин уже занят — выберите другой');
        if (err.code === 'P2003') throw new BadRequestException('Указанная должность или направление не найдены');
      }
      throw err;
    }

    return this.issueTokenFor(employee);
  }

  // Общая точка выпуска JWT — используется и паролем (login), и Telegram
  // Mini App (см. TelegramService.authenticate), чтобы оба клиента получали
  // токен одинаковой формы и одинаково проходили RBAC-guard'ы.
  async issueTokenFor(employee: TokenSubject) {
    const accessToken = await this.jwt.signAsync({
      sub: employee.id,
      email: employee.email,
      role: employee.role,
      isProfileAdmin: employee.isProfileAdmin,
    });

    return {
      accessToken,
      user: {
        id: employee.id,
        fullName: employee.fullName,
        email: employee.email,
        role: employee.role,
        isProfileAdmin: employee.isProfileAdmin,
      },
    };
  }

  // Владелец жмёт «Сбросить пароль» на карточке сотрудника — тот же UX,
  // что уже есть для привязки Telegram (TelegramService.createInvite):
  // сгенерировать одноразовую ссылку и передать сотруднику самому, лично.
  async createPasswordResetInvite(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Сотрудник не найден');

    // Предыдущие неиспользованные ссылки — аннулируем, действует только
    // последняя (тот же принцип, что у TelegramInvite).
    await this.prisma.passwordResetToken.deleteMany({ where: { employeeId, usedAt: null } });

    const token = randomBytes(24).toString('base64url');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

    await this.prisma.passwordResetToken.create({ data: { employeeId, tokenHash, expiresAt } });

    const webAppUrl = this.config.get<string>('WEB_APP_URL', 'http://localhost:3000');
    return { link: `${webAppUrl}/reset-password?token=${token}`, expiresAt };
  }

  async resetPassword(token: string, newPassword: string) {
    const tokenHash = this.hashToken(token);
    const reset = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });

    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new BadRequestException('Ссылка недействительна или истекла — запросите новую у руководителя');
    }

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.employee.update({ where: { id: reset.employeeId }, data: { passwordHash } }),
      this.prisma.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
    ]);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

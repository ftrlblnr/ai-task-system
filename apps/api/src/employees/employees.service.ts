import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { SetCompetencyDto } from './dto/set-competency.dto';
import { normalizeAliasText } from './employee-resolver.service';

const SALT_ROUNDS = 12;

const EMPLOYEE_SELECT = {
  id: true,
  fullName: true,
  photoUrl: true,
  email: true,
  telegramId: true,
  status: true,
  role: true,
  isProfileAdmin: true,
  positionId: true,
  position: { select: { id: true, title: true } },
  createdAt: true,
} as const;

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  // Раздел 5 ТЗ (скорректировано 28.08.2026): ставить задачи друг другу
  // может любой участник, не только руководитель — значит, любому нужен
  // список коллег, чтобы выбрать исполнителя. Полный каталог (email,
  // телеграм, статус, роль…) по-прежнему не публичный: подчинённый
  // получает только имена, руководитель — весь профиль.
  findAll(viewer: AuthenticatedUser) {
    if (viewer.role === Role.OWNER) {
      return this.prisma.employee.findMany({
        select: EMPLOYEE_SELECT,
        orderBy: { fullName: 'asc' },
      });
    }
    return this.prisma.employee.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    });
  }

  async findOne(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: {
        ...EMPLOYEE_SELECT,
        competencies: {
          select: { description: true, competency: { select: { id: true, name: true, description: true } } },
        },
      },
    });
    if (!employee) throw new NotFoundException('Сотрудник не найден');

    // Раньше здесь писался AuditLog READ на каждое открытие профиля,
    // включая /me на каждый заход в приложение — аудит 10.09.2026, п. 2.13,
    // тот же принцип, что и у TasksService.findOne (см. комментарий там).
    return employee;
  }

  async create(dto: CreateEmployeeDto) {
    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    return this.prisma.employee.create({
      data: {
        fullName: dto.fullName,
        email: dto.email,
        passwordHash,
        positionId: dto.positionId,
        role: dto.role,
        isProfileAdmin: dto.isProfileAdmin ?? false,
      },
      select: EMPLOYEE_SELECT,
    });
  }

  // Аудит 10.09.2026, п. 2.13: раньше руководитель мог снять роль OWNER с
  // самого себя (или с любого другого единственного оставшегося
  // руководителя) через обычный PATCH — дальше в систему было бы просто
  // некому зайти с правами, открывающими @Roles(Role.OWNER) (создание
  // сотрудников, календарь, /meetings и т.д.). Проверяем инвариант "хотя бы
  // один активный OWNER остаётся" только когда роль реально меняется С
  // OWNER на что-то другое — не блокирует ничего остального.
  async update(id: string, dto: UpdateEmployeeDto) {
    const current = await this.ensureExists(id);
    if (dto.role !== undefined && dto.role !== Role.OWNER && current.role === Role.OWNER) {
      const otherOwners = await this.prisma.employee.count({
        where: { role: Role.OWNER, status: 'ACTIVE', id: { not: id } },
      });
      if (otherOwners === 0) {
        throw new BadRequestException('Нельзя снять роль руководителя — в системе не останется ни одного OWNER');
      }
    }
    return this.prisma.employee.update({
      where: { id },
      data: dto,
      select: EMPLOYEE_SELECT,
    });
  }

  async setCompetency(employeeId: string, dto: SetCompetencyDto) {
    await this.ensureExists(employeeId);
    return this.prisma.employeeCompetency.upsert({
      where: { employeeId_competencyId: { employeeId, competencyId: dto.competencyId } },
      create: { employeeId, competencyId: dto.competencyId, description: dto.description },
      update: { description: dto.description },
    });
  }

  async removeCompetency(employeeId: string, competencyId: string) {
    await this.prisma.employeeCompetency.delete({
      where: { employeeId_competencyId: { employeeId, competencyId } },
    });
  }

  // Stage 2, Phase I (внешний аудит 21.09.2026, "Employee Resolver") —
  // ручное добавление известных коротких форм/никнеймов ("Амир" для
  // "Амир Жаксылыков"), которые эвристика EmployeeResolverService не
  // угадает сама (например, имя, не оканчивающееся на типичный падежный
  // суффикс, или прозвище, не связанное морфологически с фамилией).
  async listAliases(employeeId: string) {
    await this.ensureExists(employeeId);
    return this.prisma.employeeAlias.findMany({ where: { employeeId }, orderBy: { createdAt: 'asc' } });
  }

  async addAlias(employeeId: string, alias: string) {
    await this.ensureExists(employeeId);
    return this.prisma.employeeAlias.create({
      data: { employeeId, alias, normalizedAlias: normalizeAliasText(alias) },
    });
  }

  async removeAlias(employeeId: string, aliasId: string) {
    await this.prisma.employeeAlias.delete({ where: { id: aliasId, employeeId } });
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.employee.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!exists) throw new NotFoundException('Сотрудник не найден');
    return exists;
  }
}

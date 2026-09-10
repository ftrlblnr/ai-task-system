import { Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { SetCompetencyDto } from './dto/set-competency.dto';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  async findOne(id: string, viewerId: string) {
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

    await this.audit.log(viewerId, 'READ', 'Employee', id);
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

  async update(id: string, dto: UpdateEmployeeDto) {
    await this.ensureExists(id);
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

  private async ensureExists(id: string) {
    const exists = await this.prisma.employee.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Сотрудник не найден');
  }
}

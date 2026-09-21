import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { EmployeesService } from './employees.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { SetCompetencyDto } from './dto/set-competency.dto';
import { CreateEmployeeAliasDto } from './dto/create-employee-alias.dto';

// Список сотрудников доступен всем (раздел 5 ТЗ, скорректировано
// 28.08.2026: любой участник ставит задачи коллегам) — но сервис отдаёт
// подчинённому только имена, а полный профиль (email, телеграм, статус,
// компетенции…) по-прежнему только руководителю.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.employeesService.findAll(user);
  }

  @Get(':id')
  @Roles(Role.OWNER)
  findOne(@Param('id') id: string) {
    return this.employeesService.findOne(id);
  }

  @Post()
  @Roles(Role.OWNER)
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Patch(':id')
  @Roles(Role.OWNER)
  update(@Param('id') id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employeesService.update(id, dto);
  }

  @Post(':id/competencies')
  @Roles(Role.OWNER)
  setCompetency(@Param('id') id: string, @Body() dto: SetCompetencyDto) {
    return this.employeesService.setCompetency(id, dto);
  }

  @Delete(':id/competencies/:competencyId')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeCompetency(@Param('id') id: string, @Param('competencyId') competencyId: string) {
    return this.employeesService.removeCompetency(id, competencyId);
  }

  // Stage 2, Phase I (внешний аудит 21.09.2026, "Employee Resolver") —
  // управление известными вариантами имени сотрудника (короткие формы/
  // никнеймы), которые EmployeeResolverService использует при разборе
  // голосовых команд. OWNER-only — та же граница, что у остального
  // управления сотрудниками.
  @Get(':id/aliases')
  @Roles(Role.OWNER)
  listAliases(@Param('id') id: string) {
    return this.employeesService.listAliases(id);
  }

  @Post(':id/aliases')
  @Roles(Role.OWNER)
  addAlias(@Param('id') id: string, @Body() dto: CreateEmployeeAliasDto) {
    return this.employeesService.addAlias(id, dto.alias);
  }

  @Delete(':id/aliases/:aliasId')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  removeAlias(@Param('id') id: string, @Param('aliasId') aliasId: string) {
    return this.employeesService.removeAlias(id, aliasId);
  }
}

import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { EmployeesService } from './employees.service';

// Собственный профиль доступен любому аутентифицированному сотруднику —
// в отличие от полного каталога (раздел 5 ТЗ).
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.employeesService.findOne(user.id, user.id);
  }
}

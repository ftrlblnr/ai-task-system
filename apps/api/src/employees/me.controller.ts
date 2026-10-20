import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { EmployeesService } from './employees.service';
import { ChangeMyPasswordDto, UpdateMyProfileDto } from './dto/update-my-profile.dto';

// Собственный профиль доступен любому аутентифицированному сотруднику —
// в отличие от полного каталога (раздел 5 ТЗ). С 20.10.2026 его же можно
// редактировать (ФИО, должность, направление, пароль).
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.employeesService.findOne(user.id);
  }

  @Patch()
  updateMe(@Body() dto: UpdateMyProfileDto, @CurrentUser() user: AuthenticatedUser) {
    return this.employeesService.updateMyProfile(user.id, dto);
  }

  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  changePassword(@Body() dto: ChangeMyPasswordDto, @CurrentUser() user: AuthenticatedUser) {
    return this.employeesService.changeMyPassword(user.id, dto.currentPassword, dto.newPassword);
  }
}

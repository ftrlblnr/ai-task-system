import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { PositionsService } from '../positions/positions.service';
import { DirectionsService } from '../directions/directions.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';
import { MANAGER_ROLES } from './roles';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import type { AuthenticatedUser } from './jwt.strategy';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RegisterDto } from './dto/register.dto';
import { SetRegistrationWindowDto } from './dto/set-registration-window.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly positionsService: PositionsService,
    private readonly directionsService: DirectionsService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  // Публичный — страница регистрации показывает открыто/закрыто окно ещё
  // до того, как у посетителя появится JWT.
  @Get('registration-window')
  getRegistrationWindow() {
    return this.authService.getRegistrationWindow();
  }

  // Переключатель на странице «Сотрудники» — владелец 02.10.2026.
  @Patch('registration-window')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  setRegistrationWindow(@Body() dto: SetRegistrationWindowDto) {
    return this.authService.setRegistrationWindow(dto.isOpen, dto.days);
  }

  // Публичный — список должностей/направлений для выпадающих списков на
  // странице регистрации. Только чтение существующих: создавать новую
  // должность/направление анонимный посетитель не может (POST /positions,
  // POST /directions — только после входа) — если нужного варианта нет в
  // списке, сотрудник добавит его сам в «Моём профиле».
  @Get('register/options')
  async getRegisterOptions() {
    const [positions, directions] = await Promise.all([
      this.positionsService.findAll(),
      this.directionsService.findAll(),
    ]);
    return { positions, directions };
  }

  // Публичный — самостоятельная регистрация (владелец 02.10.2026), работает
  // только пока окно открыто (проверяется внутри authService.register).
  @Post('register')
  @HttpCode(HttpStatus.OK)
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.login, dto.password, dto.fullName, dto.positionId, dto.directionId);
  }

  // Руководитель генерирует одноразовую ссылку сброса пароля — тот же UX,
  // что у привязки Telegram (POST employees/:id/telegram-invite).
  @Post('employees/:id/password-reset-invite')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  createPasswordResetInvite(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.authService.createPasswordResetInvite(id, user);
  }

  // Публичный — сотрудник переходит по ссылке без предварительного входа
  // (у него как раз нет доступа, отсюда и сброс).
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.newPassword);
    return { ok: true };
  }
}

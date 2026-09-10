import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  // Руководитель генерирует одноразовую ссылку сброса пароля — тот же UX,
  // что у привязки Telegram (POST employees/:id/telegram-invite).
  @Post('employees/:id/password-reset-invite')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  createPasswordResetInvite(@Param('id') id: string) {
    return this.authService.createPasswordResetInvite(id);
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

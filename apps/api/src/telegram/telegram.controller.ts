import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MANAGER_ROLES } from '../auth/roles';
import { AuthService } from '../auth/auth.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { TelegramService } from './telegram.service';
import { TelegramAuthDto } from './dto/telegram-auth.dto';

@Controller()
export class TelegramController {
  constructor(
    private readonly telegramService: TelegramService,
    private readonly authService: AuthService,
  ) {}

  // Руководитель генерирует одноразовую ссылку-приглашение для сотрудника
  // (deep-link в Telegram Mini App, см. TelegramService.createInvite).
  @Post('employees/:id/telegram-invite')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  createInvite(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.telegramService.createInvite(id, user);
  }

  // Отвязать Telegram (например, сотрудник сменил телефон).
  @Delete('employees/:id/telegram-link')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MANAGER_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlink(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.telegramService.unlink(id, user);
  }

  // Вызывается Telegram Mini App при каждом открытии — не пользовательский
  // JWT-эндпоинт (его как раз и нет ещё в этот момент), доверие строится на
  // подписи initData самим Telegram (см. telegram-init-data.ts). Обрабатывает
  // и первую привязку (initData со start_param-приглашением), и обычный вход
  // уже привязанного сотрудника — единый вход в Mini App.
  @Post('auth/telegram')
  async authenticateViaTelegram(@Body() dto: TelegramAuthDto) {
    const credentials = dto.login && dto.password ? { login: dto.login, password: dto.password } : undefined;
    const employee = await this.telegramService.authenticate(dto.initData, credentials);
    return this.authService.issueTokenFor(employee);
  }
}

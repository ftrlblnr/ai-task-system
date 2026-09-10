import { Body, Controller, Delete, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AuthService } from '../auth/auth.service';
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
  @Roles(Role.OWNER)
  createInvite(@Param('id') id: string) {
    return this.telegramService.createInvite(id);
  }

  // Отвязать Telegram (например, сотрудник сменил телефон).
  @Delete('employees/:id/telegram-link')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlink(@Param('id') id: string) {
    await this.telegramService.unlink(id);
  }

  // Вызывается Telegram Mini App при каждом открытии — не пользовательский
  // JWT-эндпоинт (его как раз и нет ещё в этот момент), доверие строится на
  // подписи initData самим Telegram (см. telegram-init-data.ts). Обрабатывает
  // и первую привязку (initData со start_param-приглашением), и обычный вход
  // уже привязанного сотрудника — единый вход в Mini App.
  @Post('auth/telegram')
  async authenticateViaTelegram(@Body() dto: TelegramAuthDto) {
    const employee = await this.telegramService.authenticate(dto.initData);
    return this.authService.issueTokenFor(employee);
  }
}

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { PlaudOAuthService } from './plaud-oauth.service';
import { PlaudSyncService } from './plaud-sync.service';
import { ConnectPlaudTokenDto } from './dto/connect-plaud-token.dto';

// Синхронизация встреч из Plaud (владелец 08.09.2026) — как и календарь,
// личная интеграция руководителя, весь модуль ограничен ролью OWNER.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.OWNER)
@Controller('plaud')
export class PlaudOAuthController {
  constructor(
    private readonly oauth: PlaudOAuthService,
    private readonly sync: PlaudSyncService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('status')
  async status(@CurrentUser() user: AuthenticatedUser) {
    const connection = await this.prisma.plaudConnection.findUnique({
      where: { employeeId: user.id },
      select: { connectedAt: true, lastSyncAt: true },
    });
    return { connected: Boolean(connection), ...connection };
  }

  // Владелец вставляет refresh_token, полученный локально через `plaud
  // login` (браузерный OAuth-редирект через наш домен не работает — см.
  // комментарий в PlaudOAuthService про 400 на confirm-шаге у Plaud).
  @Post('connect-token')
  async connectWithToken(@Body() dto: ConnectPlaudTokenDto, @CurrentUser() user: AuthenticatedUser) {
    await this.oauth.connectWithRefreshToken(user.id, dto.refreshToken);
    return { ok: true };
  }

  @Delete('disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@CurrentUser() user: AuthenticatedUser) {
    return this.oauth.disconnect(user.id);
  }

  @Post('sync')
  async syncNow(@CurrentUser() user: AuthenticatedUser) {
    await this.sync.pullChanges(user.id);
    return { ok: true };
  }
}

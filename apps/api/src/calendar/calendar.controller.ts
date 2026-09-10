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
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from './events.service';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { SetGoogleOAuthConfigDto } from './dto/set-google-oauth-config.dto';
import { AddEventParticipantDto } from './dto/add-event-participant.dto';

// Календарь руководителя (раздел 14.2 ТЗ / Адъютант, скорректировано
// 28.08.2026) — личный, не общий: весь модуль ограничен ролью OWNER.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.OWNER)
@Controller()
export class CalendarController {
  constructor(
    private readonly events: EventsService,
    private readonly oauth: GoogleOAuthService,
    private readonly sync: GoogleCalendarSyncService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('events')
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.events.findAll(user.id);
  }

  @Post('events')
  create(@Body() dto: CreateEventDto, @CurrentUser() user: AuthenticatedUser) {
    return this.events.create(dto, user.id);
  }

  @Patch('events/:id')
  update(@Param('id') id: string, @Body() dto: UpdateEventDto, @CurrentUser() user: AuthenticatedUser) {
    return this.events.update(id, dto, user.id);
  }

  @Delete('events/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.events.remove(id, user.id);
  }

  @Post('events/:id/participants')
  addParticipant(@Param('id') id: string, @Body() dto: AddEventParticipantDto) {
    return this.events.addParticipant(id, dto.employeeId);
  }

  @Delete('events/:id/participants/:employeeId')
  removeParticipant(@Param('id') id: string, @Param('employeeId') employeeId: string) {
    return this.events.removeParticipant(id, employeeId);
  }

  @Get('calendar/google/status')
  async status(@CurrentUser() user: AuthenticatedUser) {
    const connection = await this.prisma.googleCalendarConnection.findUnique({
      where: { employeeId: user.id },
      select: { googleAccountEmail: true, connectedAt: true, lastSyncAt: true },
    });
    // configured — отдельно от connected: без OAuth-клиента (GoogleOAuthAppConfig)
    // кнопка «Подключить» всё равно есть в UI, но нажатие всегда упадёт (см.
    // GoogleOAuthService.getCredentials). Фронтенд по этому флагу показывает
    // форму ввода Client ID/Secret вместо непонятной ошибки после клика.
    const [configured, oauthConfig] = await Promise.all([this.oauth.isConfigured(), this.oauth.getPublicConfig()]);
    return { connected: Boolean(connection), configured, clientId: oauthConfig?.clientId, ...connection };
  }

  // Владелец вводит Client ID/Secret из Google Cloud Console сам — раздел
  // 14.2 ТЗ, без обращения к разработчику на каждую смену ключа. Секрет
  // шифруется в GoogleOAuthService.setCredentials, здесь только валидация
  // формы.
  @Post('calendar/google/oauth-config')
  async setOAuthConfig(@Body() dto: SetGoogleOAuthConfigDto) {
    await this.oauth.setCredentials(dto.clientId, dto.clientSecret);
    return { ok: true };
  }

  @Get('calendar/google/connect')
  async connect(@CurrentUser() user: AuthenticatedUser) {
    return { url: await this.oauth.buildAuthUrl(user.id) };
  }

  @Delete('calendar/google/disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@CurrentUser() user: AuthenticatedUser) {
    return this.oauth.disconnect(user.id);
  }

  @Post('calendar/google/sync')
  async syncNow(@CurrentUser() user: AuthenticatedUser) {
    await this.sync.pullChanges(user.id);
    return { ok: true };
  }
}

// Google обращается сюда напрямую — браузерным редиректом (callback) и
// server-to-server push-уведомлением (webhook), без нашего Bearer-токена.
// Поэтому без JwtAuthGuard, отдельно от остального модуля.
@Controller('calendar/google')
export class GoogleCalendarPublicController {
  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly sync: GoogleCalendarSyncService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    const webAppUrl = this.config.get<string>('WEB_APP_URL', 'http://localhost:3000');
    try {
      const employeeId = this.oauth.verifyState(state);
      await this.oauth.connect(employeeId, code);
      res.redirect(`${webAppUrl}/calendar?connected=1`);
    } catch {
      res.redirect(`${webAppUrl}/calendar?connected=0`);
    }
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() req: Request) {
    // Google Calendar push notifications: сам заголовок не несёт диффа,
    // только сигнал "что-то изменилось" — реальные изменения забираем
    // отдельным pull по каналу, которому принадлежит уведомление.
    const channelId = req.header('X-Goog-Channel-ID');
    if (!channelId) return { ok: true };

    const connection = await this.prisma.googleCalendarConnection.findFirst({
      where: { channelId },
      select: { employeeId: true },
    });
    if (!connection) return { ok: true };

    // Не блокируем ответ Google — они ждут быстрый 200, дельту тянем асинхронно.
    this.sync.pullChanges(connection.employeeId).catch(() => {});
    return { ok: true };
  }
}

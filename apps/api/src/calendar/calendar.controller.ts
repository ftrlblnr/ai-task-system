import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { assertOwnIntegration, CurrentDataOwner, DataOwnerGuard, type DataOwner } from '../auth/data-owner';
import { MANAGER_ROLES } from '../auth/roles';
import { IdempotencyService } from '../common/idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarAvailabilityService } from './calendar-availability.service';
import { CalendarPolicyService } from './calendar-policy.service';
import { EventsService } from './events.service';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { SetGoogleOAuthConfigDto } from './dto/set-google-oauth-config.dto';
import { AddEventParticipantDto } from './dto/add-event-participant.dto';
import { FindAvailabilityDto } from './dto/find-availability.dto';
import { UpdateCalendarPolicyDto } from './dto/update-calendar-policy.dto';

// Календарь руководителя (раздел 14.2 ТЗ / Адъютант, скорректировано
// 28.08.2026) — личный, не общий. С 20.10.2026 свой календарь есть и у
// администратора, а в режиме X-Act-As: leader он работает с календарём
// руководителя (см. DataOwnerGuard).
@UseGuards(JwtAuthGuard, RolesGuard, DataOwnerGuard)
@Roles(...MANAGER_ROLES)
@Controller()
export class CalendarController {
  constructor(
    private readonly events: EventsService,
    private readonly oauth: GoogleOAuthService,
    private readonly sync: GoogleCalendarSyncService,
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly availability: CalendarAvailabilityService,
    private readonly policy: CalendarPolicyService,
  ) {}

  // FIND_SLOTS (раздел 6/11/22 ТЗ календарного агента). Чтение — не
  // мутация, Idempotency-Key не требуется.
  @Post('calendar/availability')
  findAvailability(@Body() dto: FindAvailabilityDto, @CurrentDataOwner() owner: DataOwner) {
    return this.availability.findSlots(owner.id, new Date(dto.from), new Date(dto.to), dto.durationMinutes, dto.maxResults);
  }

  @Get('calendar/policy')
  getPolicy(@CurrentDataOwner() owner: DataOwner) {
    return this.policy.getOrDefault(owner.id);
  }

  @Patch('calendar/policy')
  updatePolicy(@Body() dto: UpdateCalendarPolicyDto, @CurrentDataOwner() owner: DataOwner) {
    return this.policy.update(owner.id, dto);
  }

  @Get('events')
  findAll(@CurrentDataOwner() owner: DataOwner) {
    return this.events.findAll(owner.id);
  }

  // Idempotency-Key обязателен (раздел 18.2 ТЗ календарного агента) —
  // повтор создания (двойной клик, таймаут с ретраем) не должен создавать
  // второе событие и вторую отправку в Google.
  @Post('events')
  async create(
    @Body() dto: CreateEventDto,
    @CurrentDataOwner() owner: DataOwner,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    if (!idemKey) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    const { body } = await this.idempotency.run(owner.id, idemKey, 'calendar.events.create', dto, () => this.events.create(dto, owner.id));
    return body;
  }

  @Patch('events/:id')
  update(@Param('id') id: string, @Body() dto: UpdateEventDto, @CurrentDataOwner() owner: DataOwner) {
    return this.events.update(id, dto, owner.id);
  }

  @Delete('events/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    return this.events.remove(id, owner.id);
  }

  @Post('events/:id/participants')
  addParticipant(@Param('id') id: string, @Body() dto: AddEventParticipantDto, @CurrentDataOwner() owner: DataOwner) {
    return this.events.addParticipant(id, dto.employeeId, owner.id);
  }

  @Delete('events/:id/participants/:employeeId')
  removeParticipant(@Param('id') id: string, @Param('employeeId') employeeId: string, @CurrentDataOwner() owner: DataOwner) {
    return this.events.removeParticipant(id, employeeId, owner.id);
  }

  @Get('calendar/google/status')
  async status(@CurrentDataOwner() owner: DataOwner) {
    const connection = await this.prisma.googleCalendarConnection.findUnique({
      where: { employeeId: owner.id },
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
  async setOAuthConfig(@Body() dto: SetGoogleOAuthConfigDto, @CurrentDataOwner() owner: DataOwner) {
    assertOwnIntegration(owner);
    await this.oauth.setCredentials(dto.clientId, dto.clientSecret);
    return { ok: true };
  }

  @Get('calendar/google/connect')
  async connect(@CurrentDataOwner() owner: DataOwner) {
    assertOwnIntegration(owner);
    return { url: await this.oauth.buildAuthUrl(owner.id) };
  }

  @Delete('calendar/google/disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@CurrentDataOwner() owner: DataOwner) {
    assertOwnIntegration(owner);
    return this.oauth.disconnect(owner.id);
  }

  @Post('calendar/google/sync')
  async syncNow(@CurrentDataOwner() owner: DataOwner) {
    await this.sync.pullChanges(owner.id);
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
      select: { employeeId: true, channelToken: true },
    });
    if (!connection) return { ok: true };

    // Раздел 19 ТЗ — секрет канала: без сверки с X-Goog-Channel-Token
    // любой, кто подсмотрел/угадал channelId, мог бы дёргать pull от
    // имени этого сотрудника через публичный (без JwtAuthGuard) вебхук.
    if (connection.channelToken && req.header('X-Goog-Channel-Token') !== connection.channelToken) {
      return { ok: true };
    }

    // Не блокируем ответ Google — они ждут быстрый 200, дельту тянем асинхронно.
    this.sync.pullChanges(connection.employeeId).catch(() => {});
    return { ok: true };
  }
}

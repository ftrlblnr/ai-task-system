import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { MailConnectionService } from './mail-connection.service';
import { MailQueryService, parseEmailFilters } from './mail-query.service';
import { MailStore } from './mail-store';
import { MailSyncService } from './mail-sync.service';

export class ConnectMailboxDto {
  @IsEmail()
  @MaxLength(254)
  emailAddress!: string;

  // Пароль ПРИЛОЖЕНИЯ Mail.ru — не логируется, не возвращается, хранится зашифрованным.
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  appPassword!: string;

  @IsOptional()
  @IsInt()
  @IsIn([30, 90, 180])
  initialDays?: number;
}

// Как Plaud/календарь — личная интеграция руководителя: весь модуль OWNER-only
// (решение владельца 25.09.2026). Каждый запрос работает только с ящиком ТЕКУЩЕГО
// пользователя (Mailbox.employeeId), чужие письма недоступны по id (404).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.OWNER)
@Controller('mail')
export class MailController {
  constructor(
    private readonly connection: MailConnectionService,
    private readonly sync: MailSyncService,
    private readonly store: MailStore,
    private readonly query: MailQueryService,
  ) {}

  @Get('status')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.connection.status(user.id);
  }

  @Post('connect')
  connect(@Body() dto: ConnectMailboxDto, @CurrentUser() user: AuthenticatedUser) {
    return this.connection.connect(user.id, dto);
  }

  @Delete('disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@CurrentUser() user: AuthenticatedUser) {
    return this.connection.disconnect(user.id);
  }

  // Ручное обновление — синк идёт в фоне (минуты на большой ящик), UI опрашивает статус.
  @Post('sync')
  async syncNow(@CurrentUser() user: AuthenticatedUser) {
    const mailbox = await this.requireMailbox(user);
    void this.sync.syncMailbox(mailbox.id).catch(() => undefined);
    return { started: true };
  }

  @Get('messages')
  async list(@Query() raw: Record<string, string | undefined>, @CurrentUser() user: AuthenticatedUser) {
    const mailbox = await this.requireMailbox(user);
    return this.query.search(mailbox.id, parseEmailFilters(raw), {
      limit: raw.limit ? Number(raw.limit) : undefined,
      offset: raw.offset ? Number(raw.offset) : undefined,
    });
  }

  @Get('messages/:id')
  async getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const mailbox = await this.requireMailbox(user);
    return this.query.getMessage(mailbox.id, id);
  }

  private async requireMailbox(user: AuthenticatedUser) {
    const mailbox = await this.store.getMailboxStatusByEmployee(user.id);
    if (!mailbox) throw new NotFoundException('Почта не подключена');
    return mailbox;
  }
}

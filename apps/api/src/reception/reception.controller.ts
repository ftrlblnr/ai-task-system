import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role, ReceptionRequestStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { ActiveEmployeeGuard } from './guards/active-employee.guard';
import { ReceptionService } from './reception.service';
import { IdempotencyService } from '../common/idempotency.service';
import { CreateReceptionRequestDto } from './dto/create-reception-request.dto';
import { EditReceptionRequestDto, VersionOnlyDto } from './dto/edit-reception-request.dto';
import { RejectReceptionRequestDto } from './dto/reject.dto';
import { CompleteReceptionRequestDto } from './dto/complete.dto';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function parsePaging(rawLimit?: string, rawOffset?: string): { limit: number; offset: number } {
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

// Раздел 4 ТЗ «Приёмная» — ActiveEmployeeGuard СРАЗУ после JwtAuthGuard и ДО
// RolesGuard: перечитывает сотрудника из БД, перезаписывает request.user
// живой ролью (JWT мог быть выдан до увольнения/смены роли), RolesGuard
// ниже уже видит актуальное значение. @Roles(OWNER) на конкретных методах
// (не на классе) — POST /requests доступен любому активному сотруднику.
@UseGuards(JwtAuthGuard, ActiveEmployeeGuard, RolesGuard)
@Controller('reception')
export class ReceptionController {
  constructor(
    private readonly reception: ReceptionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private requireIdempotencyKey(key: string | undefined): string {
    if (!key) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    return key;
  }

  @Post('requests')
  async create(@Body() dto: CreateReceptionRequestDto, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.create', dto, () => this.reception.create(user, dto));
    return body;
  }

  @Get('requests/mine')
  getMine(
    @Query('scope') scope: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { limit: l, offset: o } = parsePaging(limit, offset);
    return this.reception.getMine(user, scope === 'history' ? 'history' : 'active', l, o);
  }

  @Get('queue')
  @Roles(Role.OWNER)
  getQueue(
    @Query('search') search: string | undefined,
    @Query('authorId') authorId: string | undefined,
    @Query('expiredOnly') expiredOnly: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    const { limit: l, offset: o } = parsePaging(limit, offset);
    return this.reception.getQueueView({ search: search || undefined, authorId: authorId || undefined, expiredOnly: expiredOnly === 'true' }, l, o);
  }

  @Get('history')
  @Roles(Role.OWNER)
  getHistory(
    @Query('authorId') authorId: string | undefined,
    @Query('status') status: string | undefined,
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
  ) {
    const { limit: l, offset: o } = parsePaging(limit, offset);
    const terminalStatuses: string[] = ['COMPLETED', 'REJECTED', 'WITHDRAWN'];
    const parsedStatus = status && terminalStatuses.includes(status) ? (status as ReceptionRequestStatus) : undefined;
    const parsedFrom = dateFrom ? new Date(dateFrom) : undefined;
    const parsedTo = dateTo ? new Date(dateTo) : undefined;
    return this.reception.getHistory(
      {
        authorId: authorId || undefined,
        status: parsedStatus,
        closedFrom: parsedFrom && !Number.isNaN(parsedFrom.getTime()) ? parsedFrom : undefined,
        closedTo: parsedTo && !Number.isNaN(parsedTo.getTime()) ? parsedTo : undefined,
      },
      l,
      o,
    );
  }

  @Get('requests/:id')
  getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reception.getOne(user, id);
  }

  @Get('requests/:id/events')
  getEvents(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reception.getEvents(user, id);
  }

  @Patch('requests/:id')
  async edit(
    @Param('id') id: string,
    @Body() dto: EditReceptionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.edit', { id, dto }, () => this.reception.edit(user, id, dto));
    return body;
  }

  @Post('requests/:id/withdraw')
  async withdraw(
    @Param('id') id: string,
    @Body() dto: VersionOnlyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.withdraw', { id, dto }, () =>
      this.reception.withdraw(user, id, dto.version),
    );
    return body;
  }

  @Post('requests/:id/move-to-end')
  @Roles(Role.OWNER)
  async moveToEnd(
    @Param('id') id: string,
    @Body() dto: VersionOnlyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.move-to-end', { id, dto }, () =>
      this.reception.moveToEnd(user, id, dto.version),
    );
    return body;
  }

  @Post('requests/:id/call')
  @Roles(Role.OWNER)
  async call(
    @Param('id') id: string,
    @Body() dto: VersionOnlyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.call', { id, dto }, () => this.reception.call(user, id, dto.version));
    return body;
  }

  @Post('requests/:id/reject')
  @Roles(Role.OWNER)
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectReceptionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.reject', { id, dto }, () => this.reception.reject(user, id, dto));
    return body;
  }

  @Post('requests/:id/complete')
  @Roles(Role.OWNER)
  async complete(
    @Param('id') id: string,
    @Body() dto: CompleteReceptionRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.complete', { id, dto }, () =>
      this.reception.complete(user, id, dto),
    );
    return body;
  }

  @Post('requests/:id/return-to-queue')
  @Roles(Role.OWNER)
  async returnToQueue(
    @Param('id') id: string,
    @Body() dto: VersionOnlyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'reception.requests.return-to-queue', { id, dto }, () =>
      this.reception.returnToQueue(user, id, dto.version),
    );
    return body;
  }

  @Post('notifications/:id/retry')
  @Roles(Role.OWNER)
  async retryNotification(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    await this.idempotency.run(user.id, key, 'reception.notifications.retry', { id }, async () => {
      await this.reception.retryNotification(id);
      return { ok: true };
    });
    return { ok: true };
  }
}

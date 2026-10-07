import { BadRequestException, Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/jwt.strategy';
import { IdempotencyService } from '../../common/idempotency.service';
import { ApproveCalendarActionsDto } from './dto/approve-calendar-actions.dto';
import { CreateCalendarPlanDto } from './dto/create-calendar-plan.dto';
import { PatchCalendarActionDto } from './dto/patch-calendar-action.dto';
import { CalendarActionExecutionService } from './calendar-action-execution.service';
import { CalendarAuthorizationService } from './calendar-authorization.service';
import { CalendarActionCandidate, CalendarPlanService } from './calendar-plan.service';

// Раздел 22 ТЗ календарного агента — план/действия/согласие/исполнение.
// OWNER-only, тот же принцип, что CalendarController (личный календарь
// руководителя).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.OWNER)
@Controller('calendar')
export class CalendarActionController {
  constructor(
    private readonly plans: CalendarPlanService,
    private readonly authorizations: CalendarAuthorizationService,
    private readonly executions: CalendarActionExecutionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private requireIdempotencyKey(key: string | undefined): string {
    if (!key) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    return key;
  }

  @Post('plans')
  async createPlan(@Body() dto: CreateCalendarPlanDto, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const actions = dto.actions as unknown as CalendarActionCandidate[] | undefined;
    const { body } = await this.idempotency.run(user.id, key, 'calendar.plans.create', dto, () => this.plans.createPlan(user.id, dto.requestText, actions));
    return body;
  }

  @Get('plans')
  listPlans(@CurrentUser() user: AuthenticatedUser) {
    return this.plans.listPlans(user.id);
  }

  @Get('plans/:id')
  getPlan(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.getPlanOrThrow(user.id, id);
  }

  @Get('plans/:id/actions')
  listActions(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.listActions(user.id, id);
  }

  @Patch('plans/:id/actions/:actionId')
  patchAction(@Param('id') id: string, @Param('actionId') actionId: string, @Body() dto: PatchCalendarActionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.patchAction(user.id, id, actionId, dto);
  }

  @Post('plans/:id/approve')
  async approve(
    @Param('id') id: string,
    @Body() dto: ApproveCalendarActionsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'calendar.plans.approve', { id, dto }, () => this.authorizations.approve(user.id, id, dto));
    return body;
  }

  @Get('action-executions/:id')
  getExecution(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.executions.getExecutionOrThrow(user.id, id);
  }

  @Post('action-executions/:id/stop')
  async stop(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'calendar.action-executions.stop', { id }, () => this.executions.stop(user.id, id));
    return body;
  }

  @Post('action-executions/:id/retry')
  async retry(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'calendar.action-executions.retry', { id }, () => this.executions.retry(user.id, id));
    return body;
  }
}

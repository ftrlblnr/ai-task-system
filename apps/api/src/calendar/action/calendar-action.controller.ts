import { BadRequestException, Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentDataOwner, DataOwnerGuard, type DataOwner } from '../../auth/data-owner';
import { MANAGER_ROLES } from '../../auth/roles';
import { IdempotencyService } from '../../common/idempotency.service';
import { ApproveCalendarActionsDto } from './dto/approve-calendar-actions.dto';
import { CreateCalendarPlanDto } from './dto/create-calendar-plan.dto';
import { PatchCalendarActionDto } from './dto/patch-calendar-action.dto';
import { CalendarActionExecutionService } from './calendar-action-execution.service';
import { CalendarAuthorizationService } from './calendar-authorization.service';
import { CalendarActionCandidate, CalendarPlanService } from './calendar-plan.service';

// Раздел 22 ТЗ календарного агента — план/действия/согласие/исполнение.
// Руководитель/администратор, тот же принцип, что CalendarController
// (личный календарь; X-Act-As: leader — календарь руководителя).
@UseGuards(JwtAuthGuard, RolesGuard, DataOwnerGuard)
@Roles(...MANAGER_ROLES)
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
  async createPlan(@Body() dto: CreateCalendarPlanDto, @CurrentDataOwner() owner: DataOwner, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const actions = dto.actions as unknown as CalendarActionCandidate[] | undefined;
    const { body } = await this.idempotency.run(owner.id, key, 'calendar.plans.create', dto, () => this.plans.createPlan(owner.id, dto.requestText, actions));
    return body;
  }

  @Get('plans')
  listPlans(@CurrentDataOwner() owner: DataOwner) {
    return this.plans.listPlans(owner.id);
  }

  @Get('plans/:id')
  getPlan(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    return this.plans.getPlanOrThrow(owner.id, id);
  }

  @Get('plans/:id/actions')
  listActions(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    return this.plans.listActions(owner.id, id);
  }

  @Get('plans/:id/executions')
  listExecutions(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    return this.plans.listExecutions(owner.id, id);
  }

  @Patch('plans/:id/actions/:actionId')
  patchAction(@Param('id') id: string, @Param('actionId') actionId: string, @Body() dto: PatchCalendarActionDto, @CurrentDataOwner() owner: DataOwner) {
    return this.plans.patchAction(owner.id, id, actionId, dto);
  }

  @Post('plans/:id/approve')
  async approve(
    @Param('id') id: string,
    @Body() dto: ApproveCalendarActionsDto,
    @CurrentDataOwner() owner: DataOwner,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(owner.id, key, 'calendar.plans.approve', { id, dto }, () => this.authorizations.approve(owner.id, id, dto));
    return body;
  }

  @Get('action-executions/:id')
  getExecution(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    return this.executions.getExecutionOrThrow(owner.id, id);
  }

  @Post('action-executions/:id/stop')
  async stop(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(owner.id, key, 'calendar.action-executions.stop', { id }, () => this.executions.stop(owner.id, id));
    return body;
  }

  @Post('action-executions/:id/retry')
  async retry(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(owner.id, key, 'calendar.action-executions.retry', { id }, () => this.executions.retry(owner.id, id));
    return body;
  }
}

import { BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/jwt.strategy';
import { IdempotencyService } from '../../common/idempotency.service';
import { MailStore } from '../mail-store';
import { ApproveMailActionGroupDto } from './dto/approve-mail-action-group.dto';
import { CreateMailActionPlanDto } from './dto/create-mail-action-plan.dto';
import { PatchMailActionItemDto } from './dto/patch-mail-action-item.dto';
import { MailActionApprovalService } from './mail-action-approval.service';
import { MailActionExecutionService } from './mail-action-execution.service';
import { MailActionPlanService } from './mail-action-plan.service';

// Почтовый ИИ-агент v2.0 (05.10.2026) — раздел 18 ТЗ, маршруты согласования
// Этапа 1 (список/создание плана, пункты, согласие по группе, исполнение).
// OWNER-only и привязка к собственному ящику — тот же принцип, что
// MailController.requireMailbox (личная интеграция руководителя).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.OWNER)
@Controller('mail')
export class MailActionController {
  constructor(
    private readonly store: MailStore,
    private readonly plans: MailActionPlanService,
    private readonly approvals: MailActionApprovalService,
    private readonly executions: MailActionExecutionService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private requireIdempotencyKey(key: string | undefined): string {
    if (!key) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    return key;
  }

  private async requireMailbox(user: AuthenticatedUser) {
    const mailbox = await this.store.getMailboxStatusByEmployee(user.id);
    if (!mailbox) throw new NotFoundException('Почта не подключена');
    return mailbox;
  }

  @Post('action-plans')
  async createPlan(
    @Body() dto: CreateMailActionPlanDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const mailbox = await this.requireMailbox(user);
    const { body } = await this.idempotency.run(user.id, key, 'mail.action-plans.create', dto, () => this.plans.createPlan(user.id, mailbox.id, dto));
    return body;
  }

  @Get('action-plans')
  async listPlans(@CurrentUser() user: AuthenticatedUser) {
    const mailbox = await this.requireMailbox(user);
    return this.plans.listPlans(user.id, mailbox.id);
  }

  @Get('action-plans/:id')
  async getPlan(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.getPlanOrThrow(user.id, id);
  }

  @Get('action-plans/:id/items')
  async listItems(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.plans.listItemsWithConflicts(user.id, id);
  }

  @Patch('action-plans/:id/items/:itemId')
  async patchItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: PatchMailActionItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.plans.patchItem(user.id, id, itemId, dto);
  }

  @Post('action-plans/:id/approve')
  async approve(
    @Param('id') id: string,
    @Body() dto: ApproveMailActionGroupDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'mail.action-plans.approve', { id, dto }, () => this.approvals.approveGroup(user.id, id, dto));
    return body;
  }

  @Get('action-executions/:id')
  async getExecution(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.executions.getExecutionOrThrow(user.id, id);
  }

  @Post('action-executions/:id/stop')
  async stop(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'mail.action-executions.stop', { id }, () => this.executions.stop(user.id, id));
    return body;
  }

  @Post('action-executions/:id/retry')
  async retry(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(user.id, key, 'mail.action-executions.retry', { id }, () => this.executions.retry(user.id, id));
    return body;
  }
}

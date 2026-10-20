import { BadRequestException, Body, Controller, Get, Headers, Logger, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentDataOwner, DataOwnerGuard, type DataOwner } from '../../auth/data-owner';
import { MANAGER_ROLES } from '../../auth/roles';
import { IdempotencyService } from '../../common/idempotency.service';
import { MailStore } from '../mail-store';
import { ApproveMailActionGroupDto } from './dto/approve-mail-action-group.dto';
import { CreateMailActionPlanDto } from './dto/create-mail-action-plan.dto';
import { PatchMailActionItemDto } from './dto/patch-mail-action-item.dto';
import { MailActionAnalysisService } from './mail-action-analysis.service';
import { MailActionApprovalService } from './mail-action-approval.service';
import { MailActionExecutionService } from './mail-action-execution.service';
import { MailActionPlanService } from './mail-action-plan.service';

// Почтовый ИИ-агент v2.0 (05.10.2026) — раздел 18 ТЗ, маршруты согласования
// Этапа 1 (список/создание плана, пункты, согласие по группе, исполнение).
// Руководитель/администратор и привязка к ящику владельца данных — тот же
// принцип, что MailController.requireMailbox (личная интеграция; X-Act-As:
// leader — администратор согласует действия в ящике руководителя).
@UseGuards(JwtAuthGuard, RolesGuard, DataOwnerGuard)
@Roles(...MANAGER_ROLES)
@Controller('mail')
export class MailActionController {
  private readonly logger = new Logger(MailActionController.name);

  constructor(
    private readonly store: MailStore,
    private readonly plans: MailActionPlanService,
    private readonly approvals: MailActionApprovalService,
    private readonly executions: MailActionExecutionService,
    private readonly analysis: MailActionAnalysisService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private requireIdempotencyKey(key: string | undefined): string {
    if (!key) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    return key;
  }

  private async requireMailbox(owner: DataOwner) {
    const mailbox = await this.store.getMailboxStatusByEmployee(owner.id);
    if (!mailbox) throw new NotFoundException('Почта не подключена');
    return mailbox;
  }

  @Post('action-plans')
  async createPlan(
    @Body() dto: CreateMailActionPlanDto,
    @CurrentDataOwner() owner: DataOwner,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const mailbox = await this.requireMailbox(owner);
    const { body } = await this.idempotency.run(owner.id, key, 'mail.action-plans.create', dto, () => this.plans.createPlan(owner.id, mailbox.id, dto));
    // Анализ — LLM-вызов, не блокирует HTTP-ответ (план создаётся в
    // ANALYZING, клиент опрашивает GET .../:id до READY), тот же приём, что
    // approveGroup → execution.start.
    const planId = (body as { id: string }).id;
    void this.analysis.analyzePlan(planId).catch((err: unknown) => this.logger.error(`analyzePlan failed: ${err instanceof Error ? err.message : String(err)}`));
    return body;
  }

  @Get('action-plans')
  async listPlans(@CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner);
    return this.plans.listPlans(owner.id, mailbox.id);
  }

  @Get('action-plans/:id')
  async getPlan(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    return this.plans.getPlanOrThrow(owner.id, id);
  }

  @Get('action-plans/:id/items')
  async listItems(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    return this.plans.listItemsWithConflicts(owner.id, id);
  }

  @Get('action-plans/:id/context')
  async getPlanContext(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    return this.plans.getPlanContext(owner.id, id);
  }

  @Patch('action-plans/:id/items/:itemId')
  async patchItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: PatchMailActionItemDto,
    @CurrentDataOwner() owner: DataOwner,
  ) {
    return this.plans.patchItem(owner.id, id, itemId, dto);
  }

  @Post('action-plans/:id/approve')
  async approve(
    @Param('id') id: string,
    @Body() dto: ApproveMailActionGroupDto,
    @CurrentDataOwner() owner: DataOwner,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(owner.id, key, 'mail.action-plans.approve', { id, dto }, () => this.approvals.approveGroup(owner.id, id, dto));
    return body;
  }

  @Get('action-executions/:id')
  async getExecution(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner) {
    return this.executions.getExecutionOrThrow(owner.id, id);
  }

  @Post('action-executions/:id/stop')
  async stop(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(owner.id, key, 'mail.action-executions.stop', { id }, () => this.executions.stop(owner.id, id));
    return body;
  }

  @Post('action-executions/:id/retry')
  async retry(@Param('id') id: string, @CurrentDataOwner() owner: DataOwner, @Headers('idempotency-key') idemKey?: string) {
    const key = this.requireIdempotencyKey(idemKey);
    const { body } = await this.idempotency.run(owner.id, key, 'mail.action-executions.retry', { id }, () => this.executions.retry(owner.id, id));
    return body;
  }
}

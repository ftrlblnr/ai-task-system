import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { CurrentDataOwner, DataOwnerGuard, type DataOwner } from '../../auth/data-owner';
import { MANAGER_ROLES } from '../../auth/roles';
import { IdempotencyService } from '../../common/idempotency.service';
import { MAX_BODY_CHARS } from '../mail-compose.service';
import { MAILBOX_HEADER } from '../mail-servers';
import { MailStore } from '../mail-store';
import { MailTriageService } from './mail-triage.service';

class TriageTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  assigneeId?: string | null;

  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

export class TriageActionDto {
  @IsIn(['SEND_REPLY', 'CREATE_TASK', 'ARCHIVE'])
  type!: 'SEND_REPLY' | 'CREATE_TASK' | 'ARCHIVE';

  @IsOptional()
  @IsString()
  draftId?: string;

  // Правка черновика из поля «Черновик ответа» — сохраняется перед планом.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BODY_CHARS)
  draftText?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TriageTaskDto)
  task?: TriageTaskDto;
}

// Разбор почты (редизайн web W4) — те же права и ящик, что у остальной
// почты: руководство, ящик владельца данных (X-Mailbox-Id, X-Act-As: leader
// для администратора). Действия только создают план — исполнение после
// POST /mail/action-plans/:id/approve.
@UseGuards(JwtAuthGuard, RolesGuard, DataOwnerGuard)
@Roles(...MANAGER_ROLES)
@Controller('mail')
export class MailTriageController {
  constructor(
    private readonly store: MailStore,
    private readonly triage: MailTriageService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('triage')
  async queue(@Headers(MAILBOX_HEADER) mailboxId: string | undefined, @CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner, mailboxId);
    return this.triage.queue(mailbox.id);
  }

  @Post('messages/:id/draft-reply')
  @HttpCode(HttpStatus.OK)
  async draftReply(
    @Param('id') id: string,
    @Query('regenerate') regenerate: string | undefined,
    @Headers(MAILBOX_HEADER) mailboxId: string | undefined,
    @CurrentDataOwner() owner: DataOwner,
  ) {
    const mailbox = await this.requireMailboxRecord(owner, mailboxId);
    return this.triage.draftReply(mailbox, id, regenerate === 'true');
  }

  @Post('messages/:id/actions')
  async createAction(
    @Param('id') id: string,
    @Body() dto: TriageActionDto,
    @Headers(MAILBOX_HEADER) mailboxId: string | undefined,
    @CurrentDataOwner() owner: DataOwner,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    if (!idemKey) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    const mailbox = await this.requireMailboxRecord(owner, mailboxId);
    const { body } = await this.idempotency.run(owner.id, idemKey, 'mail.triage.action', { id, dto }, () => this.triage.createAction(owner.id, mailbox, id, dto, idemKey));
    return body;
  }

  @Post('messages/:id/actions/:planId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelAction(@Param('planId') planId: string, @Headers(MAILBOX_HEADER) mailboxId: string | undefined, @CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner, mailboxId);
    return this.triage.cancelAction(owner.id, mailbox.id, planId);
  }

  @Post('messages/:id/snooze')
  @HttpCode(HttpStatus.OK)
  async snooze(@Param('id') id: string, @Headers(MAILBOX_HEADER) mailboxId: string | undefined, @CurrentDataOwner() owner: DataOwner) {
    const mailbox = await this.requireMailbox(owner, mailboxId);
    return this.triage.snooze(mailbox.id, id);
  }

  private async requireMailbox(owner: DataOwner, mailboxId?: string) {
    const mailbox = await this.store.findOwnedMailbox(owner.id, mailboxId);
    if (!mailbox) throw new NotFoundException(mailboxId ? 'Ящик не найден' : 'Почта не подключена');
    return mailbox;
  }

  private async requireMailboxRecord(owner: DataOwner, mailboxId?: string) {
    const mailbox = await this.requireMailbox(owner, mailboxId);
    const record = await this.store.getMailbox(mailbox.id);
    if (!record) throw new NotFoundException('Ящик не найден');
    return record;
  }
}

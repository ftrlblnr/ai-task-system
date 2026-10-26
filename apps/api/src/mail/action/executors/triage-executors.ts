import { BadRequestException } from '@nestjs/common';
import type { MailActionItem } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuditService } from '../../../audit/audit.service';
import type { TasksService } from '../../../tasks/tasks.service';
import type { MailComposeService } from '../../mail-compose.service';
import type { MailStore } from '../../mail-store';
import { draftBodyHash } from '../../triage/mail-triage';
import type { MailActionExecutionContext, MailActionExecutor, MailActionExecutorRegistry, MailActionExecutorResult } from '../mail-action-executor';

// Разбор почты (редизайн web W4): отправка ответа и задача из письма — после
// согласия пользователя, тем же движком и журналом попыток, что архив/папки.
// Раньше SEND_REPLY/CREATE_TASK в плане падали с NOT_IMPLEMENTED.

interface SendReplyParams {
  draftId?: string;
  bodyHash?: string;
}

interface CreateTaskParams {
  title?: string;
  assigneeId?: string | null;
  dueDate?: string | null;
  description?: string;
}

export class SendReplyExecutor implements MailActionExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: MailStore,
    private readonly compose: MailComposeService,
    private readonly audit: AuditService,
  ) {}

  execute = async (item: MailActionItem, ctx: MailActionExecutionContext): Promise<MailActionExecutorResult> => {
    const params = item.parameters as SendReplyParams | null;
    if (!params?.draftId || !params.bodyHash) return { outcome: 'FAILED', errorCode: 'MISSING_DRAFT' };
    const draft = await this.prisma.mailDraft.findFirst({ where: { id: params.draftId, mailboxId: ctx.mailboxId } });
    if (!draft) return { outcome: 'FAILED', errorCode: 'DRAFT_MISSING' };
    if (draft.state === 'SENT') return { outcome: 'SUCCEEDED', providerResult: { alreadySent: true } };
    // Согласие — на точный текст: черновик правили после «Да» — не отправляем.
    if (draftBodyHash(draft.body) !== params.bodyHash) return { outcome: 'SKIPPED_CHANGED', errorCode: 'DRAFT_CHANGED' };

    const mailbox = await this.store.getMailbox(ctx.mailboxId);
    if (!mailbox) return { outcome: 'FAILED', errorCode: 'MAILBOX_MISSING' };
    try {
      const result = await this.compose.send(mailbox, draft.id);
      if (!result.alreadySent) {
        await this.audit.log(ctx.ownerId, 'MAIL_SENT', 'MailDraft', draft.id, { mailboxId: ctx.mailboxId, source: 'mail_triage', actionItemId: item.id, rejected: result.rejected.length });
      }
      return { outcome: 'SUCCEEDED', providerResult: { messageId: result.messageId, rejected: result.rejected.length } };
    } catch (err) {
      // Тексты BadRequest в MailComposeService — безопасные, для показа.
      if (err instanceof BadRequestException) return { outcome: 'FAILED', errorCode: 'SEND_FAILED', providerResult: { message: err.message } };
      throw err;
    }
  };
}

export class CreateTaskExecutor implements MailActionExecutor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
  ) {}

  execute = async (item: MailActionItem, ctx: MailActionExecutionContext): Promise<MailActionExecutorResult> => {
    const params = item.parameters as CreateTaskParams | null;
    if (!params?.title) return { outcome: 'FAILED', errorCode: 'MISSING_TITLE' };
    const owner = await this.prisma.employee.findUnique({ where: { id: ctx.ownerId }, select: { id: true, email: true, role: true } });
    if (!owner) return { outcome: 'FAILED', errorCode: 'OWNER_MISSING' };
    const task = await this.tasks.create(
      { title: params.title, description: params.description, assigneeId: params.assigneeId ?? undefined, dueDate: params.dueDate ?? undefined },
      { id: owner.id, email: owner.email, role: owner.role },
    );
    return { outcome: 'SUCCEEDED', providerResult: { taskId: task.id } };
  };
}

export function registerTriageMailActionExecutors(
  registry: MailActionExecutorRegistry,
  deps: { prisma: PrismaService; store: MailStore; compose: MailComposeService; audit: AuditService; tasks: TasksService },
): void {
  registry.register('SEND_REPLY', new SendReplyExecutor(deps.prisma, deps.store, deps.compose, deps.audit));
  registry.register('CREATE_TASK', new CreateTaskExecutor(deps.prisma, deps.tasks));
}

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { MailActionType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService, trackedCreate } from '../../ai-usage/ai-usage.service';
import { MailComposeService, type DraftView } from '../mail-compose.service';
import { MailStore, type MailboxRecord } from '../mail-store';
import { MailActionPlanService } from '../action/mail-action-plan.service';
import { GROUP_BY_ACTION_TYPE } from '../action/mail-action-rules';
import { REPLY_SYSTEM_PROMPT, buildReplyUserContent, compareTriage, draftBodyHash, nextWorkingMorning } from './mail-triage';

// Разбор почты (редизайн web W4, docs/WEB_REDESIGN.md §4.5): очередь писем,
// которые ждут ответа или действия, черновик ответа и действия над ОДНИМ
// письмом без разбора свободного текста. Любое действие — план из одного
// пункта в существующем движке mail/action: исполнение только после
// согласия пользователя (approve), тем же исполнителем и с тем же журналом.

const MODEL = 'claude-haiku-5-5';
// Очередь — свежие письма: старше двух недель «ждёт ответа» уже не разбор.
const QUEUE_WINDOW_DAYS = 14;
const QUEUE_LIMIT = 50;
// Черновики заранее — только самые свежие письма очереди и понемногу за тик.
const PREPARE_WINDOW_DAYS = 3;
export const MAX_PREPARED_DRAFTS_PER_RUN = 5;
const BODY_PREVIEW_CHARS = 8000;
// Пункты, после которых письмо уже не в очереди: сделано или делается.
const HANDLED_ITEM_TYPES: MailActionType[] = ['SEND_REPLY', 'CREATE_TASK', 'ARCHIVE'];
const HANDLED_ITEM_STATUSES = ['APPROVED', 'QUEUED', 'RUNNING', 'SUCCEEDED'] as const;

export function triageDraftKey(messageId: string): string {
  return `triage:${messageId}`;
}

export type TriageActionType = 'SEND_REPLY' | 'CREATE_TASK' | 'ARCHIVE';

export interface TriageActionInput {
  type: TriageActionType;
  draftId?: string;
  draftText?: string;
  task?: { title: string; assigneeId?: string | null; dueDate?: string | null };
}

const QUEUE_SELECT = {
  id: true,
  subject: true,
  fromName: true,
  fromAddress: true,
  receivedAt: true,
  hasAttachments: true,
  textBody: true,
  bodyTruncated: true,
  attachments: { select: { id: true, fileName: true, sizeBytes: true, fileArtifactId: true } },
  analysis: { select: { summary: true, importance: true, category: true, needsReply: true, needsAction: true, actionSummary: true, deadline: true } },
} satisfies Prisma.EmailMessageSelect;

@Injectable()
export class MailTriageService {
  private readonly logger = new Logger(MailTriageService.name);
  private client: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly store: MailStore,
    private readonly compose: MailComposeService,
    private readonly plans: MailActionPlanService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    return this.client;
  }

  // Входящие за две недели с needsReply/needsAction, без ответа, не отложенные
  // и без действия из разбора (отправлено, поручено, в архиве — или уже
  // исполняется). Порядок — compareTriage.
  private openWhere(mailboxId: string, since: Date): Prisma.EmailMessageWhereInput {
    return {
      mailboxId,
      providerMissing: false,
      isOutgoing: false,
      isAnswered: false,
      receivedAt: { gte: since },
      folder: { is: { role: 'INBOX' } },
      analysis: {
        is: {
          status: 'COMPLETED',
          OR: [{ needsReply: true }, { needsAction: true }],
          AND: [{ OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] }],
        },
      },
    };
  }

  private async handledIds(mailboxId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const items = await this.prisma.mailActionItem.findMany({
      where: { plan: { mailboxId }, type: { in: HANDLED_ITEM_TYPES }, status: { in: [...HANDLED_ITEM_STATUSES] }, stableObjectIds: { hasSome: ids } },
      select: { stableObjectIds: true },
    });
    return new Set(items.flatMap((i) => i.stableObjectIds));
  }

  async queue(mailboxId: string) {
    const since = new Date(Date.now() - QUEUE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.emailMessage.findMany({
      where: this.openWhere(mailboxId, since),
      select: QUEUE_SELECT,
      orderBy: { receivedAt: 'desc' },
      take: QUEUE_LIMIT * 2,
    });
    const handled = await this.handledIds(
      mailboxId,
      rows.map((r) => r.id),
    );
    const open = rows
      .filter((r) => !handled.has(r.id))
      .sort((a, b) => compareTriage({ importance: a.analysis?.importance ?? null, receivedAt: a.receivedAt }, { importance: b.analysis?.importance ?? null, receivedAt: b.receivedAt }))
      .slice(0, QUEUE_LIMIT);

    const drafts = await this.prisma.mailDraft.findMany({
      where: { mailboxId, sourceKey: { in: open.map((r) => triageDraftKey(r.id)) }, state: { in: ['DRAFT', 'SENDING'] } },
      select: { id: true, sourceMessageId: true, body: true, version: true, state: true, toAddresses: true, subject: true },
    });
    const draftByMessage = new Map(drafts.map((d) => [d.sourceMessageId, d]));

    return open.map(({ textBody, attachments, analysis, ...m }) => ({
      ...m,
      tag: analysis?.needsReply ? ('REPLY' as const) : ('ACTION' as const),
      analysis,
      body: textBody && textBody.length > BODY_PREVIEW_CHARS ? `${textBody.slice(0, BODY_PREVIEW_CHARS)}…` : textBody,
      attachments: attachments.map(({ fileArtifactId, ...a }) => ({ ...a, downloadable: fileArtifactId !== null })),
      draft: draftByMessage.get(m.id) ?? null,
    }));
  }

  // Черновик ответа из разбора: один на письмо (sourceKey triage:<id>),
  // повторный вызов возвращает сохранённый, regenerate — пишет заново.
  async draftReply(mailbox: MailboxRecord, messageId: string, regenerate: boolean): Promise<DraftView> {
    const message = await this.prisma.emailMessage.findFirst({
      where: { id: messageId, mailboxId: mailbox.id, providerMissing: false, isOutgoing: false },
      select: { id: true, subject: true, fromName: true, fromAddress: true, textBody: true, analysis: { select: { summary: true, actionSummary: true } } },
    });
    if (!message) throw new NotFoundException('Письмо не найдено');

    const existing = await this.prisma.mailDraft.findUnique({ where: { sourceKey: triageDraftKey(messageId) } });
    if (existing && existing.mailboxId !== mailbox.id) throw new NotFoundException('Письмо не найдено');
    if (existing && (!regenerate || existing.state !== 'DRAFT')) {
      if (regenerate) throw new ConflictException('Ответ уже отправляется или отправлен');
      return this.compose.get(mailbox.id, existing.id);
    }

    const owner = await this.prisma.employee.findUnique({ where: { id: mailbox.employeeId }, select: { fullName: true } });
    const body = await this.generateReply({
      ownerName: mailbox.displayName ?? owner?.fullName ?? null,
      subject: message.subject,
      fromName: message.fromName,
      fromAddress: message.fromAddress,
      summary: message.analysis?.summary ?? null,
      actionSummary: message.analysis?.actionSummary ?? null,
      textBody: message.textBody,
    });

    if (existing) {
      const updated = await this.prisma.mailDraft.updateMany({ where: { id: existing.id, state: 'DRAFT' }, data: { body, version: { increment: 1 }, lastError: null } });
      if (updated.count === 0) throw new ConflictException('Ответ уже отправляется или отправлен');
      return this.compose.get(mailbox.id, existing.id);
    }
    return this.compose.create(mailbox, 'REPLY', messageId, { body, sourceKey: triageDraftKey(messageId) });
  }

  private async generateReply(input: Parameters<typeof buildReplyUserContent>[0]): Promise<string> {
    const response = await trackedCreate(this.aiUsage, 'mail.draft-reply', this.getClient(), {
      model: MODEL,
      max_tokens: 1024,
      system: REPLY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildReplyUserContent(input) }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) throw new BadRequestException('Не удалось подготовить черновик — попробуйте ещё раз');
    return text;
  }

  // Фон (после синка и анализа ящика): черновики для свежих писем очереди,
  // которые ждут ответа, — чтобы разбор не ждал модель. Понемногу за тик.
  async prepareDrafts(mailboxId: string): Promise<number> {
    const mailbox = await this.store.getMailbox(mailboxId);
    if (!mailbox) return 0;
    const since = new Date(Date.now() - PREPARE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.emailMessage.findMany({
      where: { ...this.openWhere(mailboxId, since), analysis: { is: { status: 'COMPLETED', needsReply: true, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] } } },
      select: { id: true },
      orderBy: { receivedAt: 'desc' },
      take: 30,
    });
    const handled = await this.handledIds(
      mailboxId,
      rows.map((r) => r.id),
    );
    const withDraft = await this.prisma.mailDraft.findMany({
      where: { sourceKey: { in: rows.map((r) => triageDraftKey(r.id)) } },
      select: { sourceMessageId: true },
    });
    const drafted = new Set(withDraft.map((d) => d.sourceMessageId));
    const todo = rows.filter((r) => !handled.has(r.id) && !drafted.has(r.id)).slice(0, MAX_PREPARED_DRAFTS_PER_RUN);

    let prepared = 0;
    for (const { id } of todo) {
      try {
        await this.draftReply(mailbox, id, false);
        prepared++;
      } catch (err) {
        this.logger.warn(`triage draft skipped message=${id}: ${err instanceof Error ? err.name : 'unknown'}`);
      }
    }
    return prepared;
  }

  // План из одного пункта нужного типа — возвращается для согласия; сам
  // ничего не отправляет и не перемещает. key — Idempotency-Key запроса:
  // повтор возвращает тот же план.
  async createAction(ownerId: string, mailbox: MailboxRecord, messageId: string, input: TriageActionInput, key: string) {
    const message = await this.prisma.emailMessage.findFirst({
      where: { id: messageId, mailboxId: mailbox.id, providerMissing: false },
      select: { id: true, uid: true, subject: true, fromName: true, fromAddress: true, folder: { select: { path: true, uidValidity: true } }, analysis: { select: { actionSummary: true } } },
    });
    if (!message) throw new NotFoundException('Письмо не найдено');
    if (message.folder.uidValidity === null) throw new ConflictException('Письмо ещё синхронизируется — попробуйте через минуту');

    const parameters = await this.actionParameters(mailbox, message, input);
    const subject = message.subject?.trim() || '(без темы)';
    const reasons: Record<TriageActionType, string> = {
      SEND_REPLY: `Ответ на «${subject}»`,
      CREATE_TASK: `Задача по письму «${subject}»`,
      ARCHIVE: `В архив: «${subject}»`,
    };
    const plan = await this.plans.createReadyPlan(
      ownerId,
      mailbox.id,
      `Разбор почты: ${reasons[input.type]}`,
      [
        {
          localId: 'triage',
          type: input.type,
          stableObjectIds: [message.id],
          sourceLocators: { folderPath: message.folder.path, uidValidity: message.folder.uidValidity, uid: message.uid },
          reason: reasons[input.type],
          relevance: 'RECOMMENDED',
          parameters,
        },
      ],
      `triage:${ownerId}:${key}`,
    );
    const item = await this.prisma.mailActionItem.findFirstOrThrow({ where: { planId: plan.id }, select: { id: true, type: true, parameters: true } });
    return { planId: plan.id, planVersion: plan.version, itemId: item.id, type: item.type, groupType: GROUP_BY_ACTION_TYPE[item.type], parameters: item.parameters };
  }

  private async actionParameters(
    mailbox: MailboxRecord,
    message: { id: string; subject: string | null; fromName: string | null; fromAddress: string; analysis: { actionSummary: string | null } | null },
    input: TriageActionInput,
  ): Promise<Prisma.InputJsonValue> {
    switch (input.type) {
      case 'SEND_REPLY': {
        if (!input.draftId) throw new BadRequestException('Не указан черновик ответа');
        const draft = await this.prisma.mailDraft.findFirst({ where: { id: input.draftId, mailboxId: mailbox.id, sourceMessageId: message.id } });
        if (!draft) throw new NotFoundException('Черновик не найден');
        if (draft.state !== 'DRAFT') throw new ConflictException('Ответ уже отправляется или отправлен');
        let body = draft.body ?? '';
        if (input.draftText !== undefined && input.draftText !== body) {
          body = input.draftText;
          await this.prisma.mailDraft.update({ where: { id: draft.id }, data: { body, version: { increment: 1 }, lastError: null } });
        }
        if (!body.trim()) throw new BadRequestException('Текст ответа пуст');
        if (draft.toAddresses.length === 0) throw new BadRequestException('У ответа нет получателя');
        return { draftId: draft.id, bodyHash: draftBodyHash(body), to: draft.toAddresses };
      }
      case 'CREATE_TASK': {
        const title = input.task?.title?.trim();
        if (!title) throw new BadRequestException('Укажите название задачи');
        const assigneeId = input.task?.assigneeId || null;
        if (assigneeId) {
          const assignee = await this.prisma.employee.findFirst({ where: { id: assigneeId, status: 'ACTIVE' }, select: { id: true } });
          if (!assignee) throw new BadRequestException('Исполнитель не найден');
        }
        const dueDate = input.task?.dueDate || null;
        if (dueDate && Number.isNaN(new Date(dueDate).getTime())) throw new BadRequestException('Неверный срок');
        const from = message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress;
        const description = [`Из письма «${message.subject?.trim() || '(без темы)'}» от ${from}.`, message.analysis?.actionSummary].filter(Boolean).join('\n');
        return { title: title.slice(0, 300), assigneeId, dueDate: dueDate ? new Date(dueDate).toISOString() : null, description };
      }
      case 'ARCHIVE':
        // Без папки: исполнитель сам найдёт или создаст архив ящика.
        return {};
    }
  }

  // «Отмена» в окне подтверждения: несогласованный план разбора удаляется,
  // чтобы не висел в «Планах действий». Согласованный — не трогаем.
  async cancelAction(ownerId: string, mailboxId: string, planId: string): Promise<{ cancelled: boolean }> {
    const res = await this.prisma.mailActionPlan.deleteMany({
      where: {
        id: planId,
        ownerId,
        mailboxId,
        sourceKey: { startsWith: 'triage:' },
        approvals: { none: {} },
        items: { every: { status: 'NEEDS_REVIEW' } },
      },
    });
    return { cancelled: res.count > 0 };
  }

  async snooze(mailboxId: string, messageId: string): Promise<{ snoozedUntil: Date }> {
    const analysis = await this.prisma.emailAnalysis.findFirst({
      where: { emailMessageId: messageId, emailMessage: { is: { mailboxId, providerMissing: false } } },
      select: { id: true },
    });
    if (!analysis) throw new NotFoundException('Письмо не найдено');
    const snoozedUntil = nextWorkingMorning(new Date());
    await this.prisma.emailAnalysis.update({ where: { id: analysis.id }, data: { snoozedUntil } });
    return { snoozedUntil };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import type { EmailImportance, EmailReplyStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Stage 2, Phase R — запросы к ЛОКАЛЬНОЙ почте (PostgreSQL): один и тот же набор
// фильтров для веб-списка и для tools ассистента (разд. 27 ТЗ). Mail.ru здесь не
// вызывается вообще. Поиск — relational-фильтры + ILIKE (разд. 43): FTS/векторы
// только после доказанной необходимости.

export interface EmailFilters {
  dateFrom?: Date;
  dateTo?: Date;
  sender?: string;
  recipient?: string;
  subject?: string;
  query?: string;
  readStatus?: 'read' | 'unread' | 'all';
  replyStatus?: EmailReplyStatus;
  importance?: EmailImportance[];
  hasAttachments?: boolean;
  needsReply?: boolean;
  needsAction?: boolean;
  // По умолчанию только входящие: «письма за вчера» — это то, что пришло.
  direction?: 'incoming' | 'outgoing' | 'all';
}

export const MAX_LIST_LIMIT = 50;

// Чистая функция — покрыта тестами без БД.
export function buildEmailWhere(mailboxId: string, f: EmailFilters): Prisma.EmailMessageWhereInput {
  const and: Prisma.EmailMessageWhereInput[] = [];
  const where: Prisma.EmailMessageWhereInput = { mailboxId, providerMissing: false };

  const direction = f.direction ?? 'incoming';
  if (direction === 'incoming') where.isOutgoing = false;
  if (direction === 'outgoing') where.isOutgoing = true;

  if (f.dateFrom || f.dateTo) where.receivedAt = { ...(f.dateFrom ? { gte: f.dateFrom } : {}), ...(f.dateTo ? { lt: f.dateTo } : {}) };
  if (f.readStatus === 'read') where.isRead = true;
  if (f.readStatus === 'unread') where.isRead = false;
  if (f.hasAttachments !== undefined) where.hasAttachments = f.hasAttachments;

  const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const });
  if (f.subject) where.subject = contains(f.subject);
  if (f.sender) and.push({ OR: [{ fromAddress: contains(f.sender) }, { fromName: contains(f.sender) }] });
  if (f.recipient) and.push({ recipients: { some: { OR: [{ address: contains(f.recipient) }, { name: contains(f.recipient) }] } } });
  if (f.query) {
    and.push({
      OR: [
        { subject: contains(f.query) },
        { textBody: contains(f.query) },
        { fromAddress: contains(f.query) },
        { fromName: contains(f.query) },
        { analysis: { is: { summary: contains(f.query) } } },
      ],
    });
  }
  if (f.replyStatus) where.thread = { is: { replyStatus: f.replyStatus } };

  const analysis: Prisma.EmailAnalysisWhereInput = {};
  if (f.importance?.length) analysis.importance = { in: f.importance };
  if (f.needsReply !== undefined) analysis.needsReply = f.needsReply;
  if (f.needsAction !== undefined) analysis.needsAction = f.needsAction;
  if (Object.keys(analysis).length > 0) where.analysis = { is: analysis };

  if (and.length > 0) where.AND = and;
  return where;
}

const LIST_SELECT = {
  id: true,
  threadId: true,
  subject: true,
  fromAddress: true,
  fromName: true,
  receivedAt: true,
  isRead: true,
  isOutgoing: true,
  hasAttachments: true,
  thread: { select: { replyStatus: true } },
  analysis: { select: { summary: true, importance: true, category: true, needsReply: true, needsAction: true, actionSummary: true, deadline: true } },
} satisfies Prisma.EmailMessageSelect;

@Injectable()
export class MailQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async search(mailboxId: string, filters: EmailFilters, opts: { limit?: number; offset?: number } = {}) {
    const where = buildEmailWhere(mailboxId, filters);
    const requested = Number.isFinite(opts.limit) ? (opts.limit as number) : 20;
    const take = Math.min(Math.max(requested, 1), MAX_LIST_LIMIT);
    const skip = Number.isFinite(opts.offset) ? Math.max(opts.offset as number, 0) : 0;
    const [items, totalCount] = await Promise.all([
      this.prisma.emailMessage.findMany({ where, select: LIST_SELECT, orderBy: { receivedAt: 'desc' }, take, skip }),
      this.prisma.emailMessage.count({ where }),
    ]);
    return { items, totalCount };
  }

  // Письмо + тред + вложения (метаданные). Принадлежность ящику проверяется здесь:
  // чужое/несуществующее письмо — 404 (не подтверждаем существование).
  async getMessage(mailboxId: string, id: string) {
    const message = await this.prisma.emailMessage.findFirst({
      where: { id, mailboxId, providerMissing: false },
      select: {
        ...LIST_SELECT,
        internetMessageId: true,
        sentAt: true,
        textBody: true,
        bodyTruncated: true,
        recipients: { select: { type: true, address: true, name: true } },
        attachments: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true } },
      },
    });
    if (!message) throw new NotFoundException('Письмо не найдено');
    const threadMessages = message.threadId
      ? await this.prisma.emailMessage.findMany({
          where: { threadId: message.threadId, mailboxId, providerMissing: false },
          select: { id: true, subject: true, fromAddress: true, fromName: true, receivedAt: true, isOutgoing: true, isRead: true },
          orderBy: { receivedAt: 'asc' },
          take: 100,
        })
      : [];
    return { ...message, threadMessages };
  }
}

// Разбор query-параметров веб-списка (значения из URL — строки).
export function parseEmailFilters(raw: Record<string, string | undefined>): EmailFilters {
  const date = (v?: string) => {
    if (!v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  const bool = (v?: string) => (v === 'true' ? true : v === 'false' ? false : undefined);
  const replyStatuses = ['AWAITING_MY_REPLY', 'REPLIED', 'NO_REPLY_REQUIRED', 'AWAITING_THEIR_REPLY', 'UNKNOWN'];
  const importances = ['CRITICAL', 'IMPORTANT', 'NORMAL', 'LOW'];
  const readStatus = raw.readStatus === 'read' || raw.readStatus === 'unread' ? raw.readStatus : undefined;
  const direction = raw.direction === 'outgoing' || raw.direction === 'all' ? raw.direction : undefined;

  return {
    dateFrom: date(raw.dateFrom),
    dateTo: date(raw.dateTo),
    sender: raw.sender || undefined,
    recipient: raw.recipient || undefined,
    subject: raw.subject || undefined,
    query: raw.q || undefined,
    readStatus,
    replyStatus: replyStatuses.includes(raw.replyStatus ?? '') ? (raw.replyStatus as EmailReplyStatus) : undefined,
    importance: raw.importance ? (raw.importance.split(',').filter((i) => importances.includes(i)) as EmailImportance[]) : undefined,
    hasAttachments: bool(raw.hasAttachments),
    needsReply: bool(raw.needsReply),
    needsAction: bool(raw.needsAction),
    direction,
  };
}

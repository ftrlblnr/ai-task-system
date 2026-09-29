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
// Потолок писем в утренней сводке (mail-digest.cron.ts) — на объём одного
// личного ящика с запасом; текст сообщения дополнительно обрезается по
// длине (см. MAX_DIGEST_TEXT_CHARS в mail-digest.cron.ts).
export const MAX_DIGEST_ITEMS = 100;

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
        // fileArtifactId читается только чтобы посчитать downloadable ниже —
        // сам id FileArtifact наружу клиенту не отдаётся (ссылка на
        // скачивание строится по EmailAttachment.id, см. downloadAttachment
        // в mail.controller.ts).
        attachments: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true, fileArtifactId: true } },
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
    const attachments = message.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      downloadable: a.fileArtifactId !== null,
    }));
    return { ...message, attachments, threadMessages };
  }

  // Release 2 — владение вложением проверяется через владение ПИСЬМОМ
  // (тот же принцип 404-не-403, что у getMessage): чужое/несуществующее
  // вложение не подтверждает даже факт существования. fileArtifactId может
  // быть null (сохранение при синке не удалось best-effort) — тогда
  // вложение существует, но нечего скачивать.
  async getAttachmentForDownload(mailboxId: string, attachmentId: string): Promise<{ fileArtifactId: string }> {
    const attachment = await this.prisma.emailAttachment.findFirst({
      where: { id: attachmentId, emailMessage: { is: { mailboxId } } },
      select: { fileArtifactId: true },
    });
    if (!attachment || !attachment.fileArtifactId) throw new NotFoundException('Вложение не найдено');
    return { fileArtifactId: attachment.fileArtifactId };
  }

  // Дайджест (владелец 29.09.2026: "аналитика по всей почте за сутки", не
  // только важное) — ВСЕ входящие за период, полный набор полей анализа
  // (может быть null — письмо ещё не проанализировано на момент сборки
  // сводки). Сортировка по времени получения — хронология дня, не важность:
  // сама важность уже видна в тексте каждой строки.
  findAllForDigest(mailboxId: string, periodFrom: Date, periodTo: Date) {
    return this.prisma.emailMessage.findMany({
      where: { mailboxId, providerMissing: false, isOutgoing: false, receivedAt: { gte: periodFrom, lt: periodTo } },
      select: DIGEST_SELECT,
      orderBy: { receivedAt: 'asc' },
      take: MAX_DIGEST_ITEMS,
    });
  }

  // Вкладка «Дайджест» в вебе (владелец 29.09.2026) — список сохранённых
  // сводок (EmailDigest уже пишется каждое утро, см. mail-digest.cron.ts);
  // importantCount — тот же критерий, что раньше фильтровал саму сводку
  // (CRITICAL/IMPORTANT/needsReply/needsAction), теперь только для бейджа в
  // превью списка, не для отбора писем.
  async listDigests(mailboxId: string, limit: number): Promise<DigestListItem[]> {
    const digests = await this.prisma.emailDigest.findMany({
      where: { mailboxId },
      orderBy: { periodFrom: 'desc' },
      take: limit,
      select: { id: true, periodFrom: true, periodTo: true, generatedAt: true, content: true },
    });
    return digests.map((d) => {
      const items = parseDigestContent(d.content);
      return {
        id: d.id,
        periodFrom: d.periodFrom,
        periodTo: d.periodTo,
        generatedAt: d.generatedAt,
        totalCount: items.length,
        importantCount: items.filter(isImportantDigestItem).length,
      };
    });
  }

  // 404, не 403 — тот же принцип, что getMessage/getAttachmentForDownload.
  async getDigest(mailboxId: string, id: string): Promise<DigestDetail> {
    const digest = await this.prisma.emailDigest.findFirst({
      where: { id, mailboxId },
      select: { id: true, periodFrom: true, periodTo: true, generatedAt: true, content: true },
    });
    if (!digest) throw new NotFoundException('Сводка не найдена');
    return { id: digest.id, periodFrom: digest.periodFrom, periodTo: digest.periodTo, generatedAt: digest.generatedAt, items: parseDigestContent(digest.content) };
  }
}

const DIGEST_SELECT = {
  id: true,
  subject: true,
  fromAddress: true,
  fromName: true,
  receivedAt: true,
  analysis: { select: { status: true, summary: true, importance: true, category: true, needsReply: true, needsAction: true } },
} satisfies Prisma.EmailMessageSelect;

// Форма живого запроса (findAllForDigest, receivedAt — настоящий Date) —
// используется при СБОРКЕ сводки (mail-digest.cron.ts форматирует Telegram-
// текст по этой форме). После сохранения в EmailDigest.content (Postgres
// Json) и обратного чтения (StoredDigestItem ниже) receivedAt уже не Date, а
// ISO-строка — Postgres не хранит тип Date внутри jsonb, только то, во что
// он сериализовался при записи.
export type DigestEmailItem = Prisma.EmailMessageGetPayload<{ select: typeof DIGEST_SELECT }>;

export interface StoredDigestItem {
  id: string;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  receivedAt: string | null;
  analysis: {
    status: string;
    summary: string | null;
    importance: string | null;
    category: string | null;
    needsReply: boolean | null;
    needsAction: boolean | null;
  } | null;
}

export interface DigestListItem {
  id: string;
  periodFrom: Date;
  periodTo: Date;
  generatedAt: Date;
  totalCount: number;
  importantCount: number;
}

export interface DigestDetail {
  id: string;
  periodFrom: Date;
  periodTo: Date;
  generatedAt: Date;
  items: StoredDigestItem[];
}

function parseDigestContent(content: Prisma.JsonValue): StoredDigestItem[] {
  return Array.isArray(content) ? (content as unknown as StoredDigestItem[]) : [];
}

function isImportantDigestItem(i: StoredDigestItem): boolean {
  if (!i.analysis || i.analysis.status !== 'COMPLETED') return false;
  return i.analysis.importance === 'CRITICAL' || i.analysis.importance === 'IMPORTANT' || i.analysis.needsReply === true || i.analysis.needsAction === true;
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

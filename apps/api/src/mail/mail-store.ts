import { Injectable } from '@nestjs/common';
import { EmailFolderRole, Prisma, type MailboxSyncState, type MailProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { MessageFlagState, NormalizedMessage } from './providers/email-provider';
import type { MailboxServerFields } from './mail-servers';
import { deriveReplyStatus } from './reply-status';
import type { ThreadIndex } from './thread-resolver';

// Stage 2, Phase R — весь доступ синка к БД в одном тонком слое: логика синка
// (MailSyncService) тестируется на in-memory MailStore без Postgres, а этот класс —
// простой Prisma-код, проверяемый типами (CI) и реальным dogfood-синком.

export interface StoredFolder {
  id: string;
  path: string;
  role: EmailFolderRole;
  uidValidity: string | null;
  lastUid: number;
}

export interface MailboxRecord extends MailboxServerFields {
  id: string;
  employeeId: string;
  provider: MailProvider;
  displayName: string | null;
  appPasswordEncrypted: string;
  syncEnabled: boolean;
  syncState: MailboxSyncState;
  consecutiveAuthFailures: number;
  initialDays: number;
}

export interface LocalMessageRef extends MessageFlagState {
  id: string;
  uid: number;
  providerMissing: boolean;
}

const FLAG_SELECT = { isRead: true, isFlagged: true, isAnswered: true } as const;

// Release 2 — байты/извлечённый текст вложений разрешаются на уровне
// MailSyncService (FilesService/attachment-extraction.ts), не здесь: MailStore
// остаётся тонким Prisma-слоем, не знающим про FileStorage/pdfjs.
export interface ResolvedAttachment {
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  fileArtifactId: string | null;
  extractedText: string | null;
}

export interface NewMessageRecord {
  mailboxId: string;
  folderId: string;
  isOutgoing: boolean;
  threadId: string;
  message: NormalizedMessage;
  attachments: ResolvedAttachment[];
}

export interface MailboxStatePatch {
  syncState?: MailboxSyncState;
  lastError?: string | null;
  lastSyncedAt?: Date;
  consecutiveAuthFailures?: number;
}

const MAILBOX_RECORD_SELECT = {
  id: true,
  employeeId: true,
  provider: true,
  emailAddress: true,
  displayName: true,
  login: true,
  imapHost: true,
  imapPort: true,
  imapSecure: true,
  smtpHost: true,
  smtpPort: true,
  smtpSecure: true,
  appPasswordEncrypted: true,
  syncEnabled: true,
  syncState: true,
  consecutiveAuthFailures: true,
  initialDays: true,
} as const;

// provider — источник на вкладке «Дайджест»; серверы показываются в
// настройках ящика (без пароля).
const MAILBOX_STATUS_SELECT = {
  id: true,
  emailAddress: true,
  displayName: true,
  provider: true,
  imapHost: true,
  smtpHost: true,
  syncEnabled: true,
  syncState: true,
  lastError: true,
  lastSyncedAt: true,
  initialDays: true,
} as const;

@Injectable()
export class MailStore {
  constructor(private readonly prisma: PrismaService) {}

  getMailbox(id: string): Promise<MailboxRecord | null> {
    return this.prisma.mailbox.findUnique({
      where: { id },
      select: MAILBOX_RECORD_SELECT,
    });
  }

  // Ящики сотрудника без пароля (для статуса/UI) — appPasswordEncrypted наружу
  // не выбираем. Порядок — по подключению: первый ящик — «основной» по умолчанию.
  listMailboxesByEmployee(employeeId: string) {
    return this.prisma.mailbox.findMany({
      where: { employeeId },
      orderBy: { createdAt: 'asc' },
      select: MAILBOX_STATUS_SELECT,
    });
  }

  // Ящик владельца данных: конкретный (mailboxId) или первый подключённый.
  // Чужой mailboxId — null (контроллер отвечает 404).
  findOwnedMailbox(employeeId: string, mailboxId?: string | null) {
    return this.prisma.mailbox.findFirst({
      where: mailboxId ? { id: mailboxId, employeeId } : { employeeId },
      orderBy: { createdAt: 'asc' },
      select: MAILBOX_STATUS_SELECT,
    });
  }

  // Повторное подключение того же адреса заменяет реквизиты и сбрасывает ошибки.
  upsertMailbox(data: Omit<Prisma.MailboxUncheckedCreateInput, 'id'> & { employeeId: string; emailAddress: string }): Promise<{ id: string }> {
    const reset = { syncEnabled: true, syncState: 'IDLE' as const, lastError: null, consecutiveAuthFailures: 0 };
    const { employeeId, emailAddress, ...rest } = data;
    return this.prisma.mailbox.upsert({
      where: { employeeId_emailAddress: { employeeId, emailAddress } },
      create: { ...data, ...reset },
      update: { ...rest, ...reset },
      select: { id: true },
    });
  }

  async deleteMailbox(employeeId: string, mailboxId: string): Promise<boolean> {
    const res = await this.prisma.mailbox.deleteMany({ where: { id: mailboxId, employeeId } });
    return res.count > 0;
  }

  listSyncableMailboxIds(): Promise<{ id: string }[]> {
    return this.prisma.mailbox.findMany({ where: { syncEnabled: true, syncState: { not: 'PAUSED' } }, select: { id: true } });
  }

  async patchMailbox(id: string, patch: MailboxStatePatch): Promise<void> {
    await this.prisma.mailbox.update({ where: { id }, data: patch });
  }

  async upsertFolder(mailboxId: string, path: string, role: EmailFolderRole, delimiter: string | null = null): Promise<StoredFolder> {
    const seen = { role, delimiter, lastSeenAt: new Date() };
    return this.prisma.emailFolder.upsert({
      where: { mailboxId_path: { mailboxId, path } },
      create: { mailboxId, path, ...seen },
      update: seen,
      select: { id: true, path: true, role: true, uidValidity: true, lastUid: true },
    });
  }

  // Папки, которых больше нет на сервере (удалены/переименованы в другом
  // клиенте) — скрываются из интерфейса; письма остаются в БД.
  async markFoldersMissing(mailboxId: string, presentPaths: string[]): Promise<void> {
    await this.prisma.emailFolder.updateMany({ where: { mailboxId, path: { notIn: presentPaths } }, data: { lastSeenAt: null } });
  }

  async updateFolder(id: string, patch: { uidValidity?: string; lastUid?: number }): Promise<void> {
    await this.prisma.emailFolder.update({ where: { id }, data: patch });
  }

  // Почтовый ИИ-агент v2.0 — список папок уже СИНКНУТЫХ ящиком (не живой
  // IMAP-запрос): для подсказки анализу (раздел 9 ТЗ: MOVE предлагается
  // только в реально существующую папку, агент не придумывает имена).
  listFolders(mailboxId: string): Promise<{ path: string; role: EmailFolderRole }[]> {
    return this.prisma.emailFolder.findMany({ where: { mailboxId }, select: { path: true, role: true } });
  }

  findMessageByUid(folderId: string, uid: number): Promise<({ id: string } & MessageFlagState) | null> {
    return this.prisma.emailMessage.findUnique({ where: { folderId_uid: { folderId, uid } }, select: { id: true, ...FLAG_SELECT } });
  }

  // Для случая смены UIDVALIDITY: то же письмо (Message-ID) уже есть в папке под
  // старым UID — не плодим дубль, а обновляем UID.
  findMessageByInternetId(folderId: string, internetMessageId: string): Promise<{ id: string } | null> {
    return this.prisma.emailMessage.findFirst({ where: { folderId, internetMessageId }, select: { id: true } });
  }

  async setMessageUid(id: string, uid: number): Promise<void> {
    await this.prisma.emailMessage.update({ where: { id }, data: { uid, providerMissing: false, deletedAt: null } });
  }

  async setMessageFlags(id: string, flags: Partial<MessageFlagState>): Promise<void> {
    await this.prisma.emailMessage.update({ where: { id }, data: flags });
  }

  // null — письмо уже создано параллельно (unique(folderId, uid)) — не ошибка.
  async createMessage(record: NewMessageRecord): Promise<string | null> {
    const m = record.message;
    const recipients = [
      ...m.to.map((a) => ({ type: 'TO' as const, address: a.address, name: a.name ?? null })),
      ...m.cc.map((a) => ({ type: 'CC' as const, address: a.address, name: a.name ?? null })),
      ...m.bcc.map((a) => ({ type: 'BCC' as const, address: a.address, name: a.name ?? null })),
    ];
    try {
      const created = await this.prisma.emailMessage.create({
        data: {
          mailboxId: record.mailboxId,
          folderId: record.folderId,
          uid: m.uid,
          internetMessageId: m.internetMessageId,
          subject: m.subject,
          fromAddress: m.from.address,
          fromName: m.from.name ?? null,
          sentAt: m.sentAt,
          receivedAt: m.receivedAt,
          textBody: m.textBody,
          htmlBody: m.htmlBody,
          bodyTruncated: m.bodyTruncated,
          isRead: m.isRead,
          isFlagged: m.isFlagged,
          isAnswered: m.isAnswered,
          isOutgoing: record.isOutgoing,
          hasAttachments: m.hasAttachments,
          isAutomated: m.isAutomated,
          inReplyTo: m.inReplyTo,
          referencesIds: m.references,
          threadId: record.threadId,
          recipients: { create: recipients },
          attachments: {
            create: record.attachments.map((a) => ({
              fileName: a.fileName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              fileArtifactId: a.fileArtifactId,
              extractedText: a.extractedText,
            })),
          },
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  createThread(mailboxId: string, subjectNorm: string): Promise<{ id: string }> {
    return this.prisma.emailThread.create({ data: { mailboxId, subjectNorm }, select: { id: true } });
  }

  // Письмо связало ранее разные треды — переносим письма в keepId, лишние удаляем.
  async mergeThreads(keepId: string, otherIds: string[]): Promise<void> {
    if (otherIds.length === 0) return;
    await this.prisma.$transaction([
      this.prisma.emailMessage.updateMany({ where: { threadId: { in: otherIds } }, data: { threadId: keepId } }),
      this.prisma.emailThread.deleteMany({ where: { id: { in: otherIds } } }),
    ]);
  }

  // Пересчёт производных полей треда (последние письма и replyStatus).
  async refreshThread(threadId: string): Promise<void> {
    const messages = await this.prisma.emailMessage.findMany({
      where: { threadId, providerMissing: false },
      select: { receivedAt: true, sentAt: true, createdAt: true, isOutgoing: true, isAutomated: true, analysis: { select: { needsReply: true } } },
    });
    const at = (m: (typeof messages)[number]) => m.receivedAt ?? m.sentAt ?? m.createdAt;
    const incoming = messages.filter((m) => !m.isOutgoing).map(at);
    const outgoing = messages.filter((m) => m.isOutgoing).map(at);
    const max = (dates: Date[]) => (dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null);
    await this.prisma.emailThread.update({
      where: { id: threadId },
      data: {
        lastIncomingAt: max(incoming),
        lastOutgoingAt: max(outgoing),
        lastMessageAt: max([...incoming, ...outgoing]),
        replyStatus: deriveReplyStatus(
          messages.map((m) => ({ at: at(m), isOutgoing: m.isOutgoing, isAutomated: m.isAutomated, needsReply: m.analysis ? m.analysis.needsReply : null })),
        ),
      },
    });
  }

  threadIndex(mailboxId: string): ThreadIndex {
    const prisma = this.prisma;
    return {
      async findThreadIdsByMessageIds(ids) {
        const rows = await prisma.emailMessage.findMany({
          where: { mailboxId, internetMessageId: { in: ids }, threadId: { not: null } },
          select: { threadId: true },
          distinct: ['threadId'],
        });
        return rows.map((r) => r.threadId as string);
      },
      async findThreadIdsReferencing(messageId) {
        const rows = await prisma.emailMessage.findMany({
          where: { mailboxId, threadId: { not: null }, OR: [{ inReplyTo: messageId }, { referencesIds: { has: messageId } }] },
          select: { threadId: true },
          distinct: ['threadId'],
        });
        return rows.map((r) => r.threadId as string);
      },
      async findRecentThreadsBySubject(subjectNorm, since) {
        const threads = await prisma.emailThread.findMany({
          where: { mailboxId, subjectNorm, lastMessageAt: { gte: since } },
          select: { id: true, lastMessageAt: true, messages: { take: 20, select: { fromAddress: true, recipients: { select: { address: true } } } } },
        });
        return threads.map((t) => ({
          threadId: t.id,
          lastMessageAt: t.lastMessageAt as Date,
          participants: new Set(t.messages.flatMap((m) => [m.fromAddress, ...m.recipients.map((r) => r.address)])),
        }));
      },
    };
  }

  // Самый маленький UID среди недавних писем папки — нижняя граница окна, в
  // котором сверяем флаги и ищем исчезнувшие с сервера письма.
  async minUidSince(folderId: string, since: Date): Promise<number | null> {
    const row = await this.prisma.emailMessage.aggregate({
      where: { folderId, OR: [{ receivedAt: { gte: since } }, { receivedAt: null }] },
      _min: { uid: true },
    });
    return row._min.uid ?? null;
  }

  listLocalFrom(folderId: string, fromUid: number): Promise<LocalMessageRef[]> {
    return this.prisma.emailMessage.findMany({
      where: { folderId, uid: { gte: fromUid } },
      select: { id: true, uid: true, ...FLAG_SELECT, providerMissing: true },
    });
  }

  async setMissing(ids: string[], missing: boolean): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.emailMessage.updateMany({ where: { id: { in: ids } }, data: { providerMissing: missing, deletedAt: missing ? new Date() : null } });
  }

  async touchedThreadsOfMessages(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.emailMessage.findMany({ where: { id: { in: ids }, threadId: { not: null } }, select: { threadId: true }, distinct: ['threadId'] });
    return rows.map((r) => r.threadId as string);
  }

  countMessages(mailboxId: string): Promise<number> {
    return this.prisma.emailMessage.count({ where: { mailboxId, providerMissing: false } });
  }

  // Входящие, не рассылки, не пропавшие — ещё не проанализированные или
  // провалившиеся анализом менее maxAttempts раз (см. MailAnalysisService).
  listMessagesForAnalysis(mailboxId: string, maxAttempts: number, limit: number): Promise<MessageForAnalysis[]> {
    return this.prisma.emailMessage.findMany({
      where: {
        mailboxId,
        isOutgoing: false,
        isAutomated: false,
        providerMissing: false,
        // Спам и корзину не анализируем (владелец 23.10.2026: синк всех папок).
        folder: { is: { role: { notIn: ['JUNK', 'TRASH'] } } },
        OR: [{ analysis: null }, { analysis: { is: { status: 'FAILED', attempts: { lt: maxAttempts } } } }],
      },
      select: {
        id: true,
        threadId: true,
        subject: true,
        fromAddress: true,
        fromName: true,
        sentAt: true,
        receivedAt: true,
        textBody: true,
        recipients: { select: { type: true, address: true } },
        attachments: { select: { fileName: true, extractedText: true } },
      },
      orderBy: { receivedAt: 'desc' },
      take: limit,
    });
  }

  async recordAnalysisSuccess(emailMessageId: string, data: AnalysisSuccessData): Promise<void> {
    await this.prisma.emailAnalysis.upsert({
      where: { emailMessageId },
      create: { emailMessageId, status: 'COMPLETED', ...data },
      update: { status: 'COMPLETED', ...data },
    });
  }

  async recordAnalysisFailure(emailMessageId: string): Promise<void> {
    await this.prisma.emailAnalysis.upsert({
      where: { emailMessageId },
      create: { emailMessageId, status: 'FAILED', attempts: 1 },
      update: { status: 'FAILED', attempts: { increment: 1 } },
    });
  }

  // Почтовый ИИ-агент v2.0 (05.10.2026) — кандидаты для анализа плана
  // (mail-action-analysis.service.ts). folderPaths=null → только INBOX
  // (типичный сценарий "разбери входящие"), не весь ящик — агент не трогает
  // Sent/Drafts/Archive/Trash по умолчанию. Уже вынесенные в архив/корзину
  // письма не предлагаются повторно (providerMissing тоже исключён, как
  // везде — письмо реально пропало с сервера).
  async listMessagesForActionAnalysis(
    mailboxId: string,
    scope: { folderPaths: string[] | null; since: string | null; until: string | null },
    limit: number,
  ): Promise<MessageForActionAnalysis[]> {
    const folderWhere = scope.folderPaths ? { path: { in: scope.folderPaths } } : { role: 'INBOX' as const };
    return this.prisma.emailMessage.findMany({
      where: {
        mailboxId,
        isOutgoing: false,
        isAutomated: false,
        providerMissing: false,
        folder: { is: folderWhere },
        ...(scope.since || scope.until
          ? { receivedAt: { gte: scope.since ? new Date(scope.since) : undefined, lte: scope.until ? new Date(scope.until) : undefined } }
          : {}),
      },
      select: {
        id: true,
        uid: true,
        subject: true,
        fromAddress: true,
        fromName: true,
        receivedAt: true,
        isRead: true,
        hasAttachments: true,
        textBody: true,
        folder: { select: { path: true, uidValidity: true } },
        analysis: { select: { importance: true, category: true } },
      },
      orderBy: { receivedAt: 'desc' },
      take: limit,
    });
  }
}

export interface MessageForAnalysis {
  id: string;
  threadId: string | null;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  textBody: string | null;
  recipients: { type: 'TO' | 'CC' | 'BCC'; address: string }[];
  attachments: { fileName: string; extractedText: string | null }[];
}

export interface MessageForActionAnalysis {
  id: string;
  uid: number;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  receivedAt: Date | null;
  isRead: boolean;
  hasAttachments: boolean;
  textBody: string | null;
  folder: { path: string; uidValidity: string | null };
  analysis: { importance: string | null; category: string | null } | null;
}

export interface AnalysisSuccessData {
  summary: string;
  importance: Prisma.EmailAnalysisCreateInput['importance'];
  category: Prisma.EmailAnalysisCreateInput['category'];
  needsReply: boolean;
  needsAction: boolean;
  actionSummary: string | null;
  deadline: Date | null;
  inputHash: string;
  model: string;
}

import { Injectable } from '@nestjs/common';
import { EmailFolderRole, Prisma, type MailboxSyncState, type MailProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { NormalizedMessage } from './providers/email-provider';
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

export interface MailboxRecord {
  id: string;
  employeeId: string;
  provider: MailProvider;
  emailAddress: string;
  appPasswordEncrypted: string;
  syncEnabled: boolean;
  syncState: MailboxSyncState;
  consecutiveAuthFailures: number;
  initialDays: number;
}

export interface LocalMessageRef {
  id: string;
  uid: number;
  isRead: boolean;
  providerMissing: boolean;
}

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

@Injectable()
export class MailStore {
  constructor(private readonly prisma: PrismaService) {}

  getMailbox(id: string): Promise<MailboxRecord | null> {
    return this.prisma.mailbox.findUnique({
      where: { id },
      select: { id: true, employeeId: true, provider: true, emailAddress: true, appPasswordEncrypted: true, syncEnabled: true, syncState: true, consecutiveAuthFailures: true, initialDays: true },
    });
  }

  // Ящик сотрудника без пароля (для статуса/UI) — appPasswordEncrypted наружу не выбираем.
  getMailboxStatusByEmployee(employeeId: string) {
    return this.prisma.mailbox.findUnique({
      where: { employeeId },
      select: { id: true, emailAddress: true, syncEnabled: true, syncState: true, lastError: true, lastSyncedAt: true, initialDays: true },
    });
  }

  // Повторное подключение заменяет реквизиты и сбрасывает состояние ошибок.
  upsertMailbox(data: { employeeId: string; emailAddress: string; appPasswordEncrypted: string; initialDays: number }): Promise<{ id: string }> {
    const reset = { syncEnabled: true, syncState: 'IDLE' as const, lastError: null, consecutiveAuthFailures: 0 };
    return this.prisma.mailbox.upsert({
      where: { employeeId: data.employeeId },
      create: { ...data, ...reset },
      update: { emailAddress: data.emailAddress, appPasswordEncrypted: data.appPasswordEncrypted, initialDays: data.initialDays, ...reset },
      select: { id: true },
    });
  }

  async deleteMailboxByEmployee(employeeId: string): Promise<void> {
    await this.prisma.mailbox.deleteMany({ where: { employeeId } });
  }

  listSyncableMailboxIds(): Promise<{ id: string }[]> {
    return this.prisma.mailbox.findMany({ where: { syncEnabled: true, syncState: { not: 'PAUSED' } }, select: { id: true } });
  }

  async patchMailbox(id: string, patch: MailboxStatePatch): Promise<void> {
    await this.prisma.mailbox.update({ where: { id }, data: patch });
  }

  async upsertFolder(mailboxId: string, path: string, role: EmailFolderRole): Promise<StoredFolder> {
    return this.prisma.emailFolder.upsert({
      where: { mailboxId_path: { mailboxId, path } },
      create: { mailboxId, path, role },
      update: { role },
      select: { id: true, path: true, role: true, uidValidity: true, lastUid: true },
    });
  }

  async updateFolder(id: string, patch: { uidValidity?: string; lastUid?: number }): Promise<void> {
    await this.prisma.emailFolder.update({ where: { id }, data: patch });
  }

  findMessageByUid(folderId: string, uid: number): Promise<{ id: string; isRead: boolean } | null> {
    return this.prisma.emailMessage.findUnique({ where: { folderId_uid: { folderId, uid } }, select: { id: true, isRead: true } });
  }

  // Для случая смены UIDVALIDITY: то же письмо (Message-ID) уже есть в папке под
  // старым UID — не плодим дубль, а обновляем UID.
  findMessageByInternetId(folderId: string, internetMessageId: string): Promise<{ id: string } | null> {
    return this.prisma.emailMessage.findFirst({ where: { folderId, internetMessageId }, select: { id: true } });
  }

  async setMessageUid(id: string, uid: number): Promise<void> {
    await this.prisma.emailMessage.update({ where: { id }, data: { uid, providerMissing: false, deletedAt: null } });
  }

  async setMessageRead(id: string, isRead: boolean): Promise<void> {
    await this.prisma.emailMessage.update({ where: { id }, data: { isRead } });
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
      select: { id: true, uid: true, isRead: true, providerMissing: true },
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

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MailDraft, MailDraftMode } from '@prisma/client';
import { SecretBoxService } from '../crypto/secret-box.service';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailActionSessionFactory } from './action/mail-action-session-factory';
import { buildQuote, composeMessage, forwardSubject, replyRecipients, replySubject, threadHeaders, type Quote } from './mail-compose';
import type { MailboxRecord } from './mail-store';
import { MailStore } from './mail-store';
import { MailSyncService } from './mail-sync.service';
import { MailConnectError } from './providers/email-provider';
import { SmtpRejectedError, SmtpSender } from './smtp-sender';

// Написание писем (владелец 23.10.2026: «весь важный функционал, как в
// Outlook»): черновики с автосохранением, ответ/ответ всем/пересылка с
// цитатой, вложения, отправка по SMTP и копия в «Отправленные».
//
// Отправка — только по явному действию пользователя (кнопка «Отправить») или
// после показа письма и подтверждения (ассистент, этап 3). Повторное нажатие
// не отправляет дважды: черновик атомарно переходит DRAFT → SENDING.

export const MAX_RECIPIENTS = 100;
export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;
export const MAX_BODY_CHARS = 200_000;
// Отправка «зависла» (процесс перезапустился посреди SMTP) — через столько
// черновик снова можно отправить, но с предупреждением проверить «Отправленные».
const STUCK_SENDING_MS = 15 * 60 * 1000;
// Сервер может сам положить копию в «Отправленные» — даём ему немного времени.
const SENT_COPY_DELAY_MS = 1_500;
const EMAIL_RE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;

const SEND_ERROR_TEXT: Record<string, string> = {
  INVALID_CREDENTIALS: 'Сервер отправки не принял пароль — переподключите ящик',
  IMAP_DISABLED: 'Сервер отправки не принял пароль — переподключите ящик',
  TIMEOUT: 'Сервер отправки не отвечает. Письмо не отправлено — попробуйте ещё раз',
  TLS_ERROR: 'Сертификат сервера отправки не прошёл проверку',
  UNKNOWN: 'Не удалось отправить письмо. Попробуйте ещё раз',
  REJECTED: 'Сервер отказался принять письмо для этих получателей — проверьте адреса',
};

export interface DraftPatch {
  version: number;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  fileIds?: string[];
  forwardAttachmentIds?: string[];
}

export interface DraftAttachmentView {
  id: string;
  kind: 'file' | 'forward';
  fileName: string;
  sizeBytes: number | null;
}

export interface DraftView {
  id: string;
  mailboxId: string;
  mode: MailDraftMode;
  sourceMessageId: string | null;
  version: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: DraftAttachmentView[];
  quote: Quote['header'] | null;
  state: MailDraft['state'];
  lastError: string | null;
  updatedAt: Date;
}

export interface SendResult {
  ok: true;
  alreadySent?: boolean;
  messageId: string | null;
  // Сервер отклонил часть адресов — письмо ушло остальным.
  rejected: string[];
}

const SOURCE_SELECT = {
  id: true,
  internetMessageId: true,
  referencesIds: true,
  subject: true,
  fromAddress: true,
  fromName: true,
  isOutgoing: true,
  sentAt: true,
  receivedAt: true,
  textBody: true,
  htmlBody: true,
  uid: true,
  folder: { select: { path: true, uidValidity: true } },
  recipients: { select: { type: true, address: true, name: true } },
  attachments: { select: { id: true, fileArtifactId: true } },
} as const;

export function normalizeAddressList(list: string[] | undefined, field: string): string[] | undefined {
  if (list === undefined) return undefined;
  const out: string[] = [];
  for (const raw of list) {
    // «Имя <адрес>» из адресной строки — берём адрес.
    const address = (/<([^>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase();
    if (!address) continue;
    if (!EMAIL_RE.test(address)) throw new BadRequestException(`${field}: «${raw.slice(0, 100)}» — не похоже на адрес почты`);
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

@Injectable()
export class MailComposeService {
  private readonly logger = new Logger(MailComposeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: MailStore,
    private readonly secretBox: SecretBoxService,
    private readonly smtp: SmtpSender,
    private readonly files: FilesService,
    private readonly sessions: MailActionSessionFactory,
    private readonly sync: MailSyncService,
  ) {}

  async list(mailboxId: string): Promise<DraftView[]> {
    const drafts = await this.prisma.mailDraft.findMany({ where: { mailboxId, state: { in: ['DRAFT', 'SENDING'] } }, orderBy: { updatedAt: 'desc' }, take: 100 });
    return Promise.all(drafts.map((d) => this.toView(d, false)));
  }

  async get(mailboxId: string, id: string): Promise<DraftView> {
    return this.toView(await this.findDraft(mailboxId, id), true);
  }

  // Новый черновик; для ответа/пересылки — с готовыми получателями, темой и
  // (при пересылке) вложениями исходного письма.
  // init — черновик от ассистента (этап 3 почты): готовый текст, адресаты
  // пересылки и ключ вызова инструмента (повтор возвращает тот же черновик).
  async create(mailbox: MailboxRecord, mode: MailDraftMode, sourceMessageId?: string, init?: { body?: string; to?: string[]; sourceKey?: string }): Promise<DraftView> {
    if (init?.sourceKey) {
      const existing = await this.prisma.mailDraft.findUnique({ where: { sourceKey: init.sourceKey } });
      if (existing) {
        if (existing.mailboxId !== mailbox.id) throw new ConflictException('SOURCE_KEY_MISMATCH: ключ черновика занят');
        return this.toView(existing, true);
      }
    }
    if (init?.body !== undefined && init.body.length > MAX_BODY_CHARS) throw new BadRequestException('Слишком длинный текст письма');
    let data: Partial<MailDraft> = {};
    if (mode !== 'NEW') {
      if (!sourceMessageId) throw new BadRequestException('Не указано исходное письмо');
      const source = await this.findSource(mailbox.id, sourceMessageId);
      if (mode === 'FORWARD') {
        data = {
          subject: forwardSubject(source.subject),
          forwardAttachmentIds: source.attachments.filter((a) => a.fileArtifactId).map((a) => a.id),
        };
      } else {
        const { to, cc } = replyRecipients(source, mode, mailbox.emailAddress);
        data = { toAddresses: to, ccAddresses: cc, subject: replySubject(source.subject) };
      }
    }
    const draft = await this.prisma.mailDraft.create({
      data: {
        mailboxId: mailbox.id,
        mode,
        sourceMessageId: mode === 'NEW' ? null : (sourceMessageId ?? null),
        toAddresses: normalizeAddressList(init?.to, 'Кому') ?? data.toAddresses ?? [],
        ccAddresses: data.ccAddresses ?? [],
        bccAddresses: [],
        subject: data.subject ?? '',
        body: init?.body ?? '',
        forwardAttachmentIds: data.forwardAttachmentIds ?? [],
        sourceKey: init?.sourceKey ?? null,
      },
    });
    return this.toView(draft, true);
  }

  // Автосохранение. version — защита от затирания из второй вкладки: 409, если
  // черновик уже изменили.
  async update(mailbox: MailboxRecord, id: string, patch: DraftPatch): Promise<{ version: number; updatedAt: Date }> {
    const draft = await this.findDraft(mailbox.id, id);
    if (draft.state !== 'DRAFT') throw new ConflictException('Письмо уже отправляется или отправлено');
    if (patch.body !== undefined && patch.body.length > MAX_BODY_CHARS) throw new BadRequestException('Слишком длинный текст письма');

    const fileIds = patch.fileIds ? await this.checkOwnFiles(mailbox.employeeId, patch.fileIds) : undefined;
    let forwardAttachmentIds = patch.forwardAttachmentIds;
    if (forwardAttachmentIds) {
      const allowed = await this.prisma.emailAttachment.findMany({
        where: { id: { in: forwardAttachmentIds }, emailMessageId: draft.sourceMessageId ?? '__none__', fileArtifactId: { not: null } },
        select: { id: true },
      });
      forwardAttachmentIds = forwardAttachmentIds.filter((a) => allowed.some((x) => x.id === a));
    }

    const res = await this.prisma.mailDraft.updateMany({
      where: { id, version: patch.version, state: 'DRAFT' },
      data: {
        version: { increment: 1 },
        ...(patch.to !== undefined ? { toAddresses: normalizeAddressList(patch.to, 'Кому') } : {}),
        ...(patch.cc !== undefined ? { ccAddresses: normalizeAddressList(patch.cc, 'Копия') } : {}),
        ...(patch.bcc !== undefined ? { bccAddresses: normalizeAddressList(patch.bcc, 'Скрытая копия') } : {}),
        ...(patch.subject !== undefined ? { subject: patch.subject.slice(0, 998) } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(fileIds ? { fileIds } : {}),
        ...(forwardAttachmentIds ? { forwardAttachmentIds } : {}),
        lastError: null,
      },
    });
    if (res.count === 0) throw new ConflictException('Черновик изменён в другом окне — откройте его заново');
    // Снятые с письма свои вложения больше нигде не нужны.
    if (fileIds) await this.files.deleteMailUploads(mailbox.employeeId, draft.fileIds.filter((f) => !fileIds.includes(f)));
    const saved = await this.prisma.mailDraft.findUniqueOrThrow({ where: { id }, select: { version: true, updatedAt: true } });
    return saved;
  }

  async discard(mailbox: MailboxRecord, id: string): Promise<void> {
    const draft = await this.findDraft(mailbox.id, id);
    if (draft.state === 'SENDING') throw new ConflictException('Письмо уже отправляется');
    await this.prisma.mailDraft.delete({ where: { id } });
    await this.files.deleteMailUploads(mailbox.employeeId, draft.fileIds);
  }

  async send(mailbox: MailboxRecord, id: string): Promise<SendResult> {
    const draft = await this.claim(mailbox.id, id);
    if ('ok' in draft) return draft;

    let composed: Awaited<ReturnType<typeof composeMessage>>;
    let source: Awaited<ReturnType<MailComposeService['findSource']>> | null = null;
    try {
      const recipients = [...draft.toAddresses, ...draft.ccAddresses, ...draft.bccAddresses];
      if (draft.toAddresses.length === 0) throw new BadRequestException('Укажите получателя в поле «Кому»');
      if (recipients.length > MAX_RECIPIENTS) throw new BadRequestException(`Не больше ${MAX_RECIPIENTS} получателей в одном письме`);
      if (draft.sourceMessageId) source = await this.findSource(mailbox.id, draft.sourceMessageId).catch(() => null);
      if (draft.mode !== 'NEW' && !source) throw new BadRequestException('Исходное письмо больше недоступно — создайте новое письмо');
      const attachments = await this.loadAttachments(mailbox.employeeId, draft);
      composed = await composeMessage({
        from: { address: mailbox.emailAddress, name: mailbox.displayName },
        to: draft.toAddresses,
        cc: draft.ccAddresses,
        bcc: draft.bccAddresses,
        subject: draft.subject ?? '',
        body: draft.body ?? '',
        quote: source ? buildQuote(source, draft.mode) : null,
        ...(source && draft.mode !== 'FORWARD' ? threadHeaders(source) : {}),
        attachments,
      });
    } catch (err) {
      await this.release(id, err instanceof BadRequestException ? err.message : SEND_ERROR_TEXT.UNKNOWN);
      throw err instanceof BadRequestException ? err : new BadRequestException(SEND_ERROR_TEXT.UNKNOWN);
    }

    let rejected: string[] = [];
    try {
      const password = this.secretBox.decrypt(mailbox.appPasswordEncrypted);
      const result = await this.smtp.send(mailbox, { login: mailbox.login || mailbox.emailAddress, password }, composed.envelope, composed.raw);
      rejected = result.rejected;
    } catch (err) {
      const code = err instanceof SmtpRejectedError ? 'REJECTED' : err instanceof MailConnectError ? err.code : 'UNKNOWN';
      this.logger.warn(`mail send failed mailbox=${mailbox.id} code=${code}`);
      await this.release(id, SEND_ERROR_TEXT[code]);
      throw new BadRequestException(SEND_ERROR_TEXT[code]);
    }

    await this.prisma.mailDraft.update({ where: { id }, data: { state: 'SENT', sentAt: new Date(), sentMessageId: composed.messageId, lastError: null } });
    this.logger.log(`mail sent mailbox=${mailbox.id} recipients=${composed.envelope.to.length} rejected=${rejected.length}`);
    // Копия в «Отправленные», флаг «отвечено», чистка — после ответа клиенту не
    // откладываем: всё best-effort, письмо уже ушло.
    await this.afterSend(mailbox, draft, composed.messageId, composed.rawWithBcc, source).catch((err) =>
      this.logger.warn(`mail after-send failed mailbox=${mailbox.id}: ${err instanceof Error ? err.name : 'unknown'}`),
    );
    return { ok: true, messageId: composed.messageId, rejected };
  }

  // DRAFT → SENDING атомарно: второй запрос (двойной клик, повтор сети) письмо
  // повторно не отправит.
  private async claim(mailboxId: string, id: string): Promise<MailDraft | SendResult> {
    const draft = await this.findDraft(mailboxId, id);
    if (draft.state === 'SENT') return { ok: true, alreadySent: true, messageId: draft.sentMessageId, rejected: [] };
    if (draft.state === 'SENDING') {
      if (Date.now() - draft.updatedAt.getTime() < STUCK_SENDING_MS) throw new ConflictException('Письмо уже отправляется');
      await this.release(id, 'Отправка прервалась. Проверьте «Отправленные» — если письма там нет, отправьте ещё раз');
      throw new ConflictException('Отправка прервалась. Проверьте «Отправленные» — если письма там нет, отправьте ещё раз');
    }
    const claimed = await this.prisma.mailDraft.updateMany({ where: { id, state: 'DRAFT' }, data: { state: 'SENDING', lastError: null } });
    if (claimed.count === 0) throw new ConflictException('Письмо уже отправляется');
    return { ...draft, state: 'SENDING' };
  }

  private async release(id: string, error: string): Promise<void> {
    await this.prisma.mailDraft.update({ where: { id }, data: { state: 'DRAFT', lastError: error, version: { increment: 1 } } });
  }

  private async afterSend(mailbox: MailboxRecord, draft: MailDraft, messageId: string, raw: Buffer, source: Awaited<ReturnType<MailComposeService['findSource']>> | null): Promise<void> {
    await this.files.deleteMailUploads(mailbox.employeeId, draft.fileIds);
    const sent = await this.prisma.emailFolder.findFirst({ where: { mailboxId: mailbox.id, role: 'SENT', lastSeenAt: { not: null } }, select: { path: true } });
    const markAnswered = source && (draft.mode === 'REPLY' || draft.mode === 'REPLY_ALL') && source.folder.uidValidity;
    if (!sent && !markAnswered) return;

    const session = await this.sessions.openSession(mailbox.id);
    try {
      if (sent) {
        await new Promise((r) => setTimeout(r, SENT_COPY_DELAY_MS));
        const existing = await session.findUidByMessageId(sent.path, messageId);
        if (existing === null) await session.appendMessage(sent.path, raw, ['\\Seen']);
      }
      if (markAnswered && source) {
        await session.changeFlag({ folderPath: source.folder.path, uidValidity: source.folder.uidValidity as string, uid: source.uid }, '\\Answered', true);
        await this.store.setMessageFlags(source.id, { isAnswered: true });
      }
    } finally {
      await session.close().catch(() => undefined);
    }
    void this.sync.syncMailbox(mailbox.id).catch(() => undefined);
  }

  private async loadAttachments(employeeId: string, draft: MailDraft) {
    const ids = [...draft.fileIds];
    const forwarded = draft.forwardAttachmentIds.length
      ? await this.prisma.emailAttachment.findMany({
          where: { id: { in: draft.forwardAttachmentIds }, emailMessageId: draft.sourceMessageId ?? '__none__', fileArtifactId: { not: null } },
          select: { fileArtifactId: true, fileName: true },
        })
      : [];
    const own = await this.checkOwnFiles(employeeId, ids);
    const out: { filename: string; content: Buffer; contentType?: string | null }[] = [];
    let total = 0;
    for (const fileId of [...forwarded.map((f) => f.fileArtifactId as string), ...own]) {
      const { buffer, file } = await this.files.readBufferForProcessing(fileId);
      total += buffer.length;
      if (total > MAX_ATTACHMENTS_BYTES) throw new BadRequestException('Вложения больше 25 МБ — почтовые серверы такое не примут');
      out.push({ filename: forwarded.find((f) => f.fileArtifactId === fileId)?.fileName ?? file.name, content: buffer, contentType: file.mimeType });
    }
    return out;
  }

  // Свои вложения — только загруженные для почты (POST /mail/attachments) этим
  // же владельцем; чужой или посторонний id молча отбрасывается.
  private async checkOwnFiles(employeeId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.files.findMailUploads(employeeId, ids);
    return ids.filter((id) => rows.some((r) => r.id === id));
  }

  private async findDraft(mailboxId: string, id: string): Promise<MailDraft> {
    const draft = await this.prisma.mailDraft.findFirst({ where: { id, mailboxId, state: { not: 'DISCARDED' } } });
    if (!draft) throw new NotFoundException('Черновик не найден');
    return draft;
  }

  private async findSource(mailboxId: string, id: string) {
    const source = await this.prisma.emailMessage.findFirst({ where: { id, mailboxId, providerMissing: false }, select: SOURCE_SELECT });
    if (!source) throw new NotFoundException('Письмо не найдено');
    return source;
  }

  private async toView(draft: MailDraft, withQuote: boolean): Promise<DraftView> {
    const [files, forwarded, source] = await Promise.all([
      this.prisma.fileArtifact.findMany({ where: { id: { in: draft.fileIds } }, select: { id: true, name: true, size: true } }),
      this.prisma.emailAttachment.findMany({ where: { id: { in: draft.forwardAttachmentIds } }, select: { id: true, fileName: true, sizeBytes: true } }),
      withQuote && draft.sourceMessageId ? this.prisma.emailMessage.findFirst({ where: { id: draft.sourceMessageId }, select: SOURCE_SELECT }) : null,
    ]);
    return {
      id: draft.id,
      mailboxId: draft.mailboxId,
      mode: draft.mode,
      sourceMessageId: draft.sourceMessageId,
      version: draft.version,
      to: draft.toAddresses,
      cc: draft.ccAddresses,
      bcc: draft.bccAddresses,
      subject: draft.subject ?? '',
      body: draft.body ?? '',
      attachments: [
        ...forwarded.map((a) => ({ id: a.id, kind: 'forward' as const, fileName: a.fileName, sizeBytes: a.sizeBytes })),
        ...files.map((f) => ({ id: f.id, kind: 'file' as const, fileName: f.name, sizeBytes: f.size })),
      ],
      quote: source ? buildQuote(source, draft.mode).header : null,
      state: draft.state,
      lastError: draft.lastError,
      updatedAt: draft.updatedAt,
    };
  }
}

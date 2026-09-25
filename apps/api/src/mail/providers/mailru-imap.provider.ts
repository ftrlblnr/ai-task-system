import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import {
  MailConnectError,
  type EmailProvider,
  type EmailSession,
  type MailCredentials,
  type NormalizedAddress,
  type NormalizedMessage,
  type OpenedFolder,
  type ProviderFolder,
} from './email-provider';

const MAILRU_IMAP_HOST = 'imap.mail.ru';
const MAILRU_IMAP_PORT = 993;

// Потолки памяти (контейнер api — 512 МБ): письмо тяжелее MAX_SOURCE_BYTES читается
// только на этот объём (заголовки + начало), тело помечается обрезанным; тексты режутся.
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200_000;
export const MAX_HTML_CHARS = 100_000;

const NOREPLY_ADDRESS = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce[s]?)@/i;
const SENT_FOLDER_NAME = /^(sent|sent items|sent mail|отправленные)/i;

function mapConnectError(err: unknown): MailConnectError {
  const e = err as { authenticationFailed?: boolean; code?: string; responseText?: string; response?: string; message?: string };
  const text = `${e?.responseText ?? ''} ${e?.response ?? ''} ${e?.message ?? ''}`;
  if (e?.authenticationFailed) {
    // Mail.ru при выключенном доступе по IMAP отказывает на этапе логина — отличаем
    // от неверного пароля по тексту ответа сервера (best-effort, уточняется на
    // реальном ящике).
    return new MailConnectError(/imap|disabled|not enabled|отключ|включ|доступ/i.test(text) ? 'IMAP_DISABLED' : 'INVALID_CREDENTIALS');
  }
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|greeting/i.test(`${e?.code ?? ''} ${text}`)) {
    return new MailConnectError('TIMEOUT');
  }
  return new MailConnectError('UNKNOWN');
}

function toAddresses(value: AddressObject | AddressObject[] | undefined): NormalizedAddress[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  return objects
    .flatMap((o) => o.value)
    .filter((a) => a.address)
    .map((a) => ({ address: (a.address as string).toLowerCase(), name: a.name || null }));
}

function normalizeMessageId(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function headerString(parsed: ParsedMail, name: string): string {
  const value = parsed.headers.get(name);
  return typeof value === 'string' ? value : value ? JSON.stringify(value) : '';
}

// Чистая нормализация разобранного письма (вынесена ради тестов без сети).
export function normalizeParsedMail(
  parsed: ParsedMail,
  meta: { uid: number; isRead: boolean; receivedAt: Date | null; truncated: boolean },
): NormalizedMessage {
  const from = toAddresses(parsed.from)[0] ?? { address: 'unknown@invalid', name: null };
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const attachments = (parsed.attachments ?? [])
    .filter((a) => a.contentDisposition !== 'inline' || a.filename)
    .map((a) => ({ fileName: a.filename || 'attachment', mimeType: a.contentType ?? null, sizeBytes: a.size ?? null, partId: null }));

  const rawText = parsed.text ?? (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '');
  const textBody = rawText ? rawText.slice(0, MAX_TEXT_CHARS) : null;
  const htmlBody = typeof parsed.html === 'string' && parsed.html ? parsed.html.slice(0, MAX_HTML_CHARS) : null;

  const automated =
    NOREPLY_ADDRESS.test(from.address) ||
    Boolean(headerString(parsed, 'list-unsubscribe')) ||
    /bulk|list|junk/i.test(headerString(parsed, 'precedence')) ||
    (headerString(parsed, 'auto-submitted') !== '' && headerString(parsed, 'auto-submitted').toLowerCase() !== 'no');

  return {
    uid: meta.uid,
    internetMessageId: normalizeMessageId(parsed.messageId),
    subject: parsed.subject ?? null,
    from,
    to: toAddresses(parsed.to),
    cc: toAddresses(parsed.cc),
    bcc: toAddresses(parsed.bcc),
    sentAt: parsed.date ?? null,
    receivedAt: meta.receivedAt,
    textBody,
    htmlBody,
    bodyTruncated: meta.truncated || rawText.length > MAX_TEXT_CHARS,
    isRead: meta.isRead,
    hasAttachments: attachments.length > 0,
    isAutomated: automated,
    inReplyTo: normalizeMessageId(parsed.inReplyTo),
    references: references.map((r) => r.trim()).filter(Boolean),
    attachments,
  };
}

class MailRuImapSession implements EmailSession {
  constructor(private readonly client: ImapFlow) {}

  async folders(): Promise<ProviderFolder[]> {
    const list = await this.client.list();
    const result: ProviderFolder[] = [];
    for (const f of list) {
      if (f.path.toUpperCase() === 'INBOX') result.push({ path: f.path, role: 'INBOX' });
      else if (f.specialUse === '\\Sent' || SENT_FOLDER_NAME.test(f.path)) result.push({ path: f.path, role: 'SENT' });
    }
    // Если сервер вернул несколько кандидатов на Sent — берём первый (по special-use он один).
    const seen = new Set<string>();
    return result.filter((f) => (seen.has(f.role) ? false : (seen.add(f.role), true)));
  }

  async openFolder(path: string): Promise<OpenedFolder> {
    const info = await this.client.mailboxOpen(path, { readOnly: true });
    return { uidValidity: String(info.uidValidity) };
  }

  async fetchNew(path: string, afterUid: number, since: Date | null, limit: number): Promise<NormalizedMessage[]> {
    const lock = await this.client.getMailboxLock(path, { readOnly: true });
    try {
      const query = afterUid > 0 ? { uid: `${afterUid + 1}:*` } : since ? { since } : { all: true };
      const found = (await this.client.search(query, { uid: true })) || [];
      // «N:*» всегда возвращает хотя бы последнее письмо, даже если его uid ≤ N.
      const uids = found.filter((u) => u > afterUid).sort((a, b) => a - b).slice(0, limit);

      const messages: NormalizedMessage[] = [];
      for (const uid of uids) {
        // Строго по одному письму — пик памяти ограничен MAX_SOURCE_BYTES.
        const msg = await this.client.fetchOne(
          String(uid),
          { uid: true, flags: true, internalDate: true, size: true, source: { maxLength: MAX_SOURCE_BYTES } },
          { uid: true },
        );
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const internalDate = msg.internalDate ? new Date(msg.internalDate) : null;
        messages.push(
          normalizeParsedMail(parsed, {
            uid,
            isRead: Boolean(msg.flags?.has('\\Seen')),
            receivedAt: internalDate,
            truncated: (msg.size ?? 0) > MAX_SOURCE_BYTES,
          }),
        );
      }
      return messages;
    } finally {
      lock.release();
    }
  }

  async fetchFlagsFrom(path: string, fromUid: number): Promise<Map<number, boolean>> {
    const lock = await this.client.getMailboxLock(path, { readOnly: true });
    try {
      const flags = new Map<number, boolean>();
      for await (const msg of this.client.fetch(`${Math.max(fromUid, 1)}:*`, { uid: true, flags: true }, { uid: true })) {
        if (msg.uid >= fromUid) flags.set(msg.uid, Boolean(msg.flags?.has('\\Seen')));
      }
      return flags;
    } finally {
      lock.release();
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // соединение уже закрыто сервером — закрывать нечего
    }
  }
}

@Injectable()
export class MailRuImapProvider implements EmailProvider {
  async openSession(credentials: MailCredentials): Promise<EmailSession> {
    const client = new ImapFlow({
      host: MAILRU_IMAP_HOST,
      port: MAILRU_IMAP_PORT,
      secure: true,
      auth: { user: credentials.emailAddress, pass: credentials.appPassword },
      // logger: false — иначе imapflow логирует обмен, включая LOGIN с паролем.
      logger: false,
    });
    try {
      await client.connect();
    } catch (err) {
      throw mapConnectError(err);
    }
    return new MailRuImapSession(client);
  }
}

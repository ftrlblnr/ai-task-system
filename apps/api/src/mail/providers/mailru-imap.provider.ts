import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import {
  MailConnectError,
  StaleLocatorError,
  type EmailProvider,
  type EmailSession,
  type MailCredentials,
  type MessageFlag,
  type MessageLocator,
  type MoveResult,
  type NormalizedAddress,
  type NormalizedMessage,
  type OpenedFolder,
  type ProviderCapabilities,
  type ProviderFolder,
  type ProviderFolderRole,
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

// Чистая функция (вынесена ради тестов без сети, тот же приём, что
// normalizeParsedMail). Подтверждено живым подключением 05.10.2026: Mail.ru
// не объявляет SPECIAL-USE в CAPABILITY, но сообщает те же роли через XLIST
// (ImapFlow сам приводит их к одному и тому же полю specialUse) — отдельная
// ветка под XLIST не нужна, только единая проверка specialUse + INBOX по
// имени (INBOX — специальный регистронезависимый путь по RFC 3501, его
// сервер отдельным флагом не помечает).
export function mapSpecialUseToRole(path: string, specialUse: string | null): ProviderFolderRole {
  if (path.toUpperCase() === 'INBOX') return 'INBOX';
  switch (specialUse) {
    case '\\Sent':
      return 'SENT';
    case '\\Archive':
      return 'ARCHIVE';
    case '\\Drafts':
      return 'DRAFTS';
    case '\\Junk':
      return 'JUNK';
    case '\\Trash':
      return 'TRASH';
    default:
      // Фолбэк по имени — только для Sent (единственная роль, которой уже
      // доверяли по имени до этого шага, см. SENT_FOLDER_NAME ниже); для
      // Archive/Drafts/Trash жёсткое сопоставление по имени ТЗ прямо
      // запрещает (раздел 9: "не по жёсткому русскому/английскому имени").
      return SENT_FOLDER_NAME.test(path) ? 'SENT' : 'OTHER';
  }
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
    .map((a) => ({ fileName: a.filename || 'attachment', mimeType: a.contentType ?? null, sizeBytes: a.size ?? null, partId: null, content: a.content }));

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
    const all = await this.listAllFolders();
    const result = all.filter((f) => f.role === 'INBOX' || f.role === 'SENT');
    // Если сервер вернул несколько кандидатов на Sent — берём первый (по special-use он один).
    const seen = new Set<string>();
    return result.filter((f) => (seen.has(f.role) ? false : (seen.add(f.role), true)));
  }

  // Почтовый ИИ-агент v2.0 (05.10.2026) — ВСЕ папки, не только INBOX/SENT
  // (folders() выше существующий синк не трогает, это для охвата/выбора
  // папок в плане, раздел 4/9 ТЗ).
  async listAllFolders(): Promise<ProviderFolder[]> {
    const list = await this.client.list();
    return list.map((f) => ({
      path: f.path,
      role: mapSpecialUseToRole(f.path, f.specialUse ?? null),
      specialUse: f.specialUse ?? null,
    }));
  }

  capabilities(): ProviderCapabilities {
    return {
      move: this.client.capabilities.has('MOVE'),
      uidplus: this.client.capabilities.has('UIDPLUS'),
    };
  }

  // Открывает папку НЕ readOnly (в отличие от fetchNew/fetchFlagsFrom —
  // это пишущая операция) и сверяет UIDVALIDITY с locator ДО перемещения —
  // раздел 15 ТЗ: "Старые координаты при смене UIDVALIDITY не исполнять".
  async moveMessage(locator: MessageLocator, toFolderPath: string): Promise<MoveResult> {
    const caps = this.capabilities();
    if (!caps.move) {
      // Раздел 15 ТЗ: "При отсутствии безопасного механизма — отказ операции
      // с объяснением" — COPY + общий EXPUNGE здесь НЕ реализован намеренно
      // (слишком легко случайно затронуть чужие сообщения в папке).
      throw new Error('Провайдер не поддерживает безопасное перемещение (MOVE) — операция недоступна');
    }
    const lock = await this.client.getMailboxLock(locator.folderPath);
    try {
      const status = await this.client.status(locator.folderPath, { uidValidity: true });
      if (String(status.uidValidity) !== locator.uidValidity) {
        throw new StaleLocatorError();
      }
      const result = await this.client.messageMove(String(locator.uid), toFolderPath, { uid: true });
      if (!result) {
        throw new Error('Перемещение не выполнено сервером');
      }
      const newUid = result.uidMap?.get(locator.uid) ?? null;
      return {
        newUid: newUid ?? null,
        newUidValidity: result.uidValidity != null ? String(result.uidValidity) : null,
      };
    } finally {
      lock.release();
    }
  }

  async changeFlag(locator: MessageLocator, flag: MessageFlag, set: boolean): Promise<void> {
    const lock = await this.client.getMailboxLock(locator.folderPath);
    try {
      const status = await this.client.status(locator.folderPath, { uidValidity: true });
      if (String(status.uidValidity) !== locator.uidValidity) {
        throw new StaleLocatorError();
      }
      // Только ЭТОТ один флаг (massageFlagsAdd/Remove затрагивают ровно
      // переданный список, не весь набор) — раздел 9/15 ТЗ.
      if (set) await this.client.messageFlagsAdd(String(locator.uid), [flag], { uid: true });
      else await this.client.messageFlagsRemove(String(locator.uid), [flag], { uid: true });
    } finally {
      lock.release();
    }
  }

  async createFolder(parentPath: string | null, name: string): Promise<ProviderFolder & { created: boolean }> {
    const path = parentPath ? [parentPath, name] : [name];
    const result = await this.client.mailboxCreate(path);
    return { path: result.path, role: 'OTHER', specialUse: null, created: result.created };
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

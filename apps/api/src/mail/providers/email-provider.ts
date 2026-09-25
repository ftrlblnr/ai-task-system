// Stage 2, Phase R (Mail.ru Email Intelligence, 25.09.2026) — абстракция почтового
// провайдера: бизнес-логика (синк, треды, анализ, ассистент) знает только этот
// интерфейс, а не Mail.ru/IMAP. Сейчас единственная реализация — MailRuImapProvider;
// позже Microsoft365/Gmail/произвольный IMAP.

export type MailErrorCode = 'INVALID_CREDENTIALS' | 'IMAP_DISABLED' | 'TIMEOUT' | 'UNKNOWN';

// Ошибка подключения с БЕЗОПАСНЫМ кодом — текст исходного исключения наружу не
// отдаётся и не логируется (в нём могут оказаться данные сервера/логин).
export class MailConnectError extends Error {
  constructor(public readonly code: MailErrorCode) {
    super(code);
    this.name = 'MailConnectError';
  }
}

export interface MailCredentials {
  emailAddress: string;
  appPassword: string;
}

export type ProviderFolderRole = 'INBOX' | 'SENT';

export interface ProviderFolder {
  path: string;
  role: ProviderFolderRole;
}

export interface NormalizedAddress {
  address: string;
  name?: string | null;
}

export interface NormalizedAttachment {
  fileName: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  partId?: string | null;
}

// Письмо в нормализованном виде — то, что синк кладёт в PostgreSQL.
export interface NormalizedMessage {
  uid: number;
  internetMessageId: string | null;
  subject: string | null;
  from: NormalizedAddress;
  to: NormalizedAddress[];
  cc: NormalizedAddress[];
  bcc: NormalizedAddress[];
  sentAt: Date | null;
  receivedAt: Date | null;
  textBody: string | null;
  htmlBody: string | null;
  bodyTruncated: boolean;
  isRead: boolean;
  hasAttachments: boolean;
  // Рассылка/автоответ по заголовкам — правила без LLM.
  isAutomated: boolean;
  inReplyTo: string | null;
  references: string[];
  attachments: NormalizedAttachment[];
}

export interface OpenedFolder {
  // Меняется, когда сервер перенумеровал UID — курсор тогда недействителен.
  uidValidity: string;
}

export interface EmailSession {
  folders(): Promise<ProviderFolder[]>;
  openFolder(path: string): Promise<OpenedFolder>;
  // Письма папки в порядке возрастания UID: только uid > afterUid, при afterUid=0 —
  // не старше since. Не более limit штук за вызов (синк идёт батчами).
  fetchNew(path: string, afterUid: number, since: Date | null, limit: number): Promise<NormalizedMessage[]>;
  // UID → isRead для всех писем папки с uid >= fromUid (лёгкий запрос флагов):
  // обновление прочитанности и обнаружение исчезнувших с сервера писем.
  fetchFlagsFrom(path: string, fromUid: number): Promise<Map<number, boolean>>;
  close(): Promise<void>;
}

export interface EmailProvider {
  openSession(credentials: MailCredentials): Promise<EmailSession>;
}

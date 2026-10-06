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

export type ProviderFolderRole = 'INBOX' | 'SENT' | 'ARCHIVE' | 'DRAFTS' | 'JUNK' | 'TRASH' | 'OTHER';

export interface ProviderFolder {
  path: string;
  role: ProviderFolderRole;
  // Сырой special-use флаг сервера (\Archive, \Trash, ...) — null, если
  // сервер его не сообщил. Почтовый агент v2.0 (раздел 9 ТЗ) определяет
  // Archive/Sent/Drafts/Trash через него, не по жёсткому имени.
  specialUse: string | null;
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
  // Байты вложения — mailparser уже декодирует их при разборе письма
  // (Release 2); сохранение/извлечение текста — забота вызывающего кода
  // (MailSyncService), провайдер только отдаёт то, что у него уже есть.
  content: Buffer;
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

// Почтовый ИИ-агент v2.0 (ТЗ, 05.10.2026, раздел 15) — "Неподдерживаемое
// действие показывается как недоступное, а не имитируется локально".
// Подтверждено живым подключением к реальному ящику владельца (05.10.2026):
// Mail.ru сообщает MOVE и UIDPLUS в CAPABILITY — безопасный UID MOVE
// доступен напрямую, рискованный fallback COPY+выборочный EXPUNGE для этого
// провайдера не нужен (раздел 15 ТЗ отдельно предупреждает: "Общий EXPUNGE
// запрещён, так как может затронуть другие сообщения").
export interface ProviderCapabilities {
  move: boolean;
  uidplus: boolean;
}

// Точная удалённая координата письма (раздел 15 ТЗ: "(mailboxId, folderPath,
// UIDVALIDITY, UID)" — mailboxId уже знает вызывающий код на уровне БД,
// здесь — только то, что относится к самому IMAP-соединению).
export interface MessageLocator {
  folderPath: string;
  uidValidity: string;
  uid: number;
}

export interface MoveResult {
  // Новые координаty письма после перемещения — null, если сервер их не
  // вернул (нет UIDPLUS) и нужна отдельная сверка (раздел 15 ТЗ:
  // "При отсутствии однозначного сопоставления — сверка и
  // NEEDS_RECONCILIATION, не успех по одному исчезновению из источника").
  newUid: number | null;
  newUidValidity: string | null;
}

// Координаты изменились на сервере с момента snapshot (другой клиент
// переместил письмо, сменился UIDVALIDITY и т.п.) — раздел 14/15 ТЗ:
// "Старые координаты при смене UIDVALIDITY не исполнять". Отдельный класс,
// не обычная MailConnectError — вызывающий код различает их (эта не о
// соединении, а о протухшем согласии на конкретный объект).
export class StaleLocatorError extends Error {
  constructor(message = 'Координаты письма изменились с момента согласования') {
    super(message);
    this.name = 'StaleLocatorError';
  }
}

export type MessageFlag = '\\Seen' | '\\Flagged';

export interface EmailSession {
  folders(): Promise<ProviderFolder[]>;
  openFolder(path: string): Promise<OpenedFolder>;
  // Письма папки в порядке возрастания UID: только uid > afterUid, при afterUid=0 —
  // не старше since. Не более limit штук за вызов (синк идёт батчами).
  fetchNew(path: string, afterUid: number, since: Date | null, limit: number): Promise<NormalizedMessage[]>;
  // UID → isRead для всех писем папки с uid >= fromUid (лёгкий запрос флагов):
  // обновление прочитанности и обнаружение исчезнувших с сервера писем.
  fetchFlagsFrom(path: string, fromUid: number): Promise<Map<number, boolean>>;

  // --- Почтовый ИИ-агент v2.0 (05.10.2026) — этап 1 ---

  capabilities(): ProviderCapabilities;
  // ВСЕ папки ящика с ролью/special-use (не только INBOX/SENT, как folders()
  // выше — тот метод существующий синк не трогаем, это отдельный метод для
  // охвата/выбора папок в плане, раздел 4/9 ТЗ).
  listAllFolders(): Promise<ProviderFolder[]>;
  // Бросает StaleLocatorError, если текущий UIDVALIDITY папки не совпадает с
  // locator.uidValidity. Перемещение — ровно ОДНО письмо, не диапазон (раздел
  // 9 ТЗ: "Одна выбранная запись означает одно письмо, не всю цепочку").
  moveMessage(locator: MessageLocator, toFolderPath: string): Promise<MoveResult>;
  // Меняет РОВНО один флаг (раздел 9/15 ТЗ — не весь набор, чтобы не стереть
  // параллельные изменения). set=true — добавить, false — снять.
  changeFlag(locator: MessageLocator, flag: MessageFlag, set: boolean): Promise<void>;
  // parentPath=null — папка верхнего уровня. created=false в ответе — папка
  // с таким именем/родителем уже существовала (раздел 9 ТЗ: "не создавать
  // дубликат").
  createFolder(parentPath: string | null, name: string): Promise<ProviderFolder & { created: boolean }>;

  close(): Promise<void>;
}

export interface EmailProvider {
  openSession(credentials: MailCredentials): Promise<EmailSession>;
}

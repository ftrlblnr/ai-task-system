import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MailProvider } from '@prisma/client';
import { SecretBoxService } from '../crypto/secret-box.service';
import { MailStore } from './mail-store';
import { MailProviderRegistry } from './mail-provider.registry';
import { MailSyncService } from './mail-sync.service';
import { credentialsFor, MAIL_RU_SERVERS, type MailServerSettings } from './mail-servers';
import { SmtpSender } from './smtp-sender';
import { MailConnectError, type MailErrorCode } from './providers/email-provider';

export const ALLOWED_INITIAL_DAYS = [30, 90, 180];
export const MAX_MAILBOXES_PER_EMPLOYEE = 5;

// Понятные владельцу тексты — без деталей сервера (могут содержать данные ящика).
const MAILRU_ERROR_MESSAGES: Record<MailErrorCode, string> = {
  INVALID_CREDENTIALS:
    'Неверный адрес или пароль приложения Mail.ru. Нужен пароль для внешнего приложения (создаётся в настройках безопасности Mail.ru), а не обычный пароль от почты.',
  IMAP_DISABLED:
    'Доступ к почте по IMAP выключен. Включите его в настройках Mail.ru («Почтовые программы») и повторите подключение.',
  TIMEOUT: 'Mail.ru не отвечает. Повторите подключение через несколько минут.',
  TLS_ERROR: 'Не удалось установить защищённое соединение с Mail.ru. Повторите попытку позже.',
  UNKNOWN: 'Не удалось подключиться к Mail.ru. Проверьте адрес и повторите попытку.',
};

const SERVER_ERROR_MESSAGES: Record<MailErrorCode, string> = {
  INVALID_CREDENTIALS: 'Сервер отклонил логин или пароль. Проверьте их — те же, что вы вводили в Outlook.',
  IMAP_DISABLED: 'Сервер отклонил вход: возможно, доступ по IMAP выключен для этого ящика. Уточните у администратора почты.',
  TIMEOUT: 'Сервер не отвечает. Проверьте адрес сервера и порт.',
  TLS_ERROR: 'Сертификат сервера не прошёл проверку. Проверьте адрес сервера — он должен совпадать с указанным в Outlook.',
  UNKNOWN: 'Не удалось подключиться к серверу. Проверьте адрес, порт и шифрование.',
};

export interface ConnectMailboxParams {
  provider?: MailProvider;
  emailAddress: string;
  appPassword: string;
  initialDays?: number;
  displayName?: string;
  login?: string;
  // Для IMAP — обязательно, для MAIL_RU игнорируется (пресет).
  servers?: MailServerSettings;
}

@Injectable()
export class MailConnectionService {
  private readonly logger = new Logger(MailConnectionService.name);

  constructor(
    private readonly store: MailStore,
    private readonly secretBox: SecretBoxService,
    private readonly registry: MailProviderRegistry,
    private readonly sync: MailSyncService,
    private readonly smtp: SmtpSender,
  ) {}

  // Пароль проверяется РЕАЛЬНЫМ входом по IMAP и SMTP ДО сохранения; хранится
  // только зашифрованным (SecretBox), наружу/в лог/в промпт не попадает.
  // Повторное подключение того же адреса обновляет реквизиты.
  async connect(employeeId: string, params: ConnectMailboxParams): Promise<{ ok: true; mailboxId: string }> {
    const initialDays = params.initialDays ?? 30;
    if (!ALLOWED_INITIAL_DAYS.includes(initialDays)) {
      throw new BadRequestException(`Окно первой синхронизации: ${ALLOWED_INITIAL_DAYS.join(' / ')} дней`);
    }
    const provider = params.provider ?? 'MAIL_RU';
    const emailAddress = params.emailAddress.trim().toLowerCase();
    const servers = provider === 'MAIL_RU' ? MAIL_RU_SERVERS : params.servers;
    if (!servers) throw new BadRequestException('Укажите серверы IMAP и SMTP');
    const login = provider === 'MAIL_RU' ? null : params.login?.trim() || null;
    const displayName = params.displayName?.trim() || null;
    const messages = provider === 'MAIL_RU' ? MAILRU_ERROR_MESSAGES : SERVER_ERROR_MESSAGES;

    const existing = await this.store.listMailboxesByEmployee(employeeId);
    if (!existing.some((m) => m.emailAddress === emailAddress) && existing.length >= MAX_MAILBOXES_PER_EMPLOYEE) {
      throw new BadRequestException(`Можно подключить не больше ${MAX_MAILBOXES_PER_EMPLOYEE} ящиков`);
    }

    const fields = { emailAddress, login, ...servers };
    try {
      const session = await this.registry.get(provider).openSession(credentialsFor(fields, params.appPassword));
      await session.close();
    } catch (err) {
      const code = err instanceof MailConnectError ? err.code : 'UNKNOWN';
      this.logger.warn(`mail connect rejected employee=${employeeId} stage=imap code=${code}`);
      throw new BadRequestException(`IMAP: ${messages[code]}`);
    }
    try {
      await this.smtp.verify(servers, { login: login || emailAddress, password: params.appPassword });
    } catch (err) {
      const code = err instanceof MailConnectError ? err.code : 'UNKNOWN';
      this.logger.warn(`mail connect rejected employee=${employeeId} stage=smtp code=${code}`);
      throw new BadRequestException(`Отправка (SMTP): ${messages[code]}`);
    }

    const mailbox = await this.store.upsertMailbox({
      employeeId,
      provider,
      emailAddress,
      displayName,
      login,
      ...servers,
      appPasswordEncrypted: this.secretBox.encrypt(params.appPassword),
      initialDays,
    });
    // Начальная синхронизация — в фоне: POST не ждёт минуты загрузки писем.
    void this.sync.syncMailbox(mailbox.id).catch(() => undefined);
    return { ok: true, mailboxId: mailbox.id };
  }

  async status(employeeId: string) {
    const mailboxes = await this.store.listMailboxesByEmployee(employeeId);
    return {
      mailboxes: await Promise.all(mailboxes.map(async (m) => ({ ...m, messageCount: await this.store.countMessages(m.id) }))),
    };
  }

  async disconnect(employeeId: string, mailboxId: string): Promise<void> {
    const deleted = await this.store.deleteMailbox(employeeId, mailboxId);
    if (!deleted) throw new NotFoundException('Ящик не найден');
  }
}

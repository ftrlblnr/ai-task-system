import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SecretBoxService } from '../crypto/secret-box.service';
import { MailStore } from './mail-store';
import { MailProviderRegistry } from './mail-provider.registry';
import { MailSyncService } from './mail-sync.service';
import { MailConnectError, type MailErrorCode } from './providers/email-provider';

export const ALLOWED_INITIAL_DAYS = [30, 90, 180];

// Понятные владельцу тексты — без деталей сервера (могут содержать данные ящика).
const CONNECT_ERROR_MESSAGES: Record<MailErrorCode, string> = {
  INVALID_CREDENTIALS:
    'Неверный адрес или пароль приложения Mail.ru. Нужен пароль для внешнего приложения (создаётся в настройках безопасности Mail.ru), а не обычный пароль от почты.',
  IMAP_DISABLED:
    'Доступ к почте по IMAP выключен. Включите его в настройках Mail.ru («Почтовые программы») и повторите подключение.',
  TIMEOUT: 'Mail.ru не отвечает. Повторите подключение через несколько минут.',
  UNKNOWN: 'Не удалось подключиться к Mail.ru. Проверьте адрес и повторите попытку.',
};

@Injectable()
export class MailConnectionService {
  private readonly logger = new Logger(MailConnectionService.name);

  constructor(
    private readonly store: MailStore,
    private readonly secretBox: SecretBoxService,
    private readonly registry: MailProviderRegistry,
    private readonly sync: MailSyncService,
  ) {}

  // Пароль приложения проверяется РЕАЛЬНЫМ входом по IMAP ДО сохранения; хранится
  // только зашифрованным (SecretBox), наружу/в лог/в промпт не попадает.
  async connect(employeeId: string, params: { emailAddress: string; appPassword: string; initialDays?: number }): Promise<{ ok: true }> {
    const initialDays = params.initialDays ?? 30;
    if (!ALLOWED_INITIAL_DAYS.includes(initialDays)) {
      throw new BadRequestException(`Окно первой синхронизации: ${ALLOWED_INITIAL_DAYS.join(' / ')} дней`);
    }
    const emailAddress = params.emailAddress.trim().toLowerCase();

    try {
      const session = await this.registry.get('MAIL_RU').openSession({ emailAddress, appPassword: params.appPassword });
      await session.close();
    } catch (err) {
      const code = err instanceof MailConnectError ? err.code : 'UNKNOWN';
      this.logger.warn(`mail connect rejected employee=${employeeId} code=${code}`);
      throw new BadRequestException(CONNECT_ERROR_MESSAGES[code]);
    }

    const mailbox = await this.store.upsertMailbox({
      employeeId,
      emailAddress,
      appPasswordEncrypted: this.secretBox.encrypt(params.appPassword),
      initialDays,
    });
    // Начальная синхронизация — в фоне: POST не ждёт минуты загрузки писем.
    void this.sync.syncMailbox(mailbox.id).catch(() => undefined);
    return { ok: true };
  }

  async status(employeeId: string) {
    const mailbox = await this.store.getMailboxStatusByEmployee(employeeId);
    if (!mailbox) return { connected: false as const };
    return { connected: true as const, ...mailbox, messageCount: await this.store.countMessages(mailbox.id) };
  }

  disconnect(employeeId: string): Promise<void> {
    return this.store.deleteMailboxByEmployee(employeeId);
  }
}

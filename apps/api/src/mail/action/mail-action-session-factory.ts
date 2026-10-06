import { Injectable } from '@nestjs/common';
import { SecretBoxService } from '../../crypto/secret-box.service';
import { MailStore } from '../mail-store';
import { MailProviderRegistry } from '../mail-provider.registry';
import type { EmailSession } from '../providers/email-provider';

// Открывает ОДНУ реальную IMAP-сессию на ящик — тот же приём, что
// MailSyncService.syncMailbox() (registry.get(provider).openSession с
// расшифровкой appPassword). Выделено отдельным сервисом, чтобы движок
// исполнения (mail-action-execution.service.ts) не тянул
// MailStore/SecretBoxService/MailProviderRegistry напрямую — и чтобы юнит-
// тесты движка могли подменить его одним простым fake, не тремя.
@Injectable()
export class MailActionSessionFactory {
  constructor(
    private readonly store: MailStore,
    private readonly secretBox: SecretBoxService,
    private readonly registry: MailProviderRegistry,
  ) {}

  async openSession(mailboxId: string): Promise<EmailSession> {
    const mailbox = await this.store.getMailbox(mailboxId);
    if (!mailbox) throw new Error(`Mailbox ${mailboxId} not found`);
    return this.registry.get(mailbox.provider).openSession({
      emailAddress: mailbox.emailAddress,
      appPassword: this.secretBox.decrypt(mailbox.appPasswordEncrypted),
    });
  }
}

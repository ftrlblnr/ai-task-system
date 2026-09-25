import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailStore } from './mail-store';
import { MailSyncService } from './mail-sync.service';

// Опрос раз в 10 минут — для утренней сводки достаточно (IMAP IDLE не нужен).
// Соединение короткоживущее на один синк — меньше риск лимитов Mail.ru на логины.
@Injectable()
export class MailSyncCron {
  private readonly logger = new Logger(MailSyncCron.name);

  constructor(
    private readonly store: MailStore,
    private readonly sync: MailSyncService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncAll(): Promise<void> {
    const mailboxes = await this.store.listSyncableMailboxIds();
    for (const { id } of mailboxes) {
      try {
        await this.sync.syncMailbox(id);
      } catch (err) {
        this.logger.warn(`Фоновая синхронизация почты не удалась mailbox=${id}: ${err instanceof Error ? err.name : 'unknown'}`);
      }
    }
  }
}

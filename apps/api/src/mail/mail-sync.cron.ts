import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailAnalysisService } from './mail-analysis.service';
import { MailStore } from './mail-store';
import { MailSyncService } from './mail-sync.service';

// Опрос раз в 10 минут — для утренней сводки достаточно (IMAP IDLE не нужен).
// Соединение короткоживущее на один синк — меньше риск лимитов Mail.ru на логины.
// AI-анализ (Release 2) идёт сразу после синка того же ящика, не отдельным
// cron'ом — IMAP-сессия уже закрыта, а свежесинканные письма анализируются
// в тот же тик без лишней 10-минутной задержки.
@Injectable()
export class MailSyncCron {
  private readonly logger = new Logger(MailSyncCron.name);

  constructor(
    private readonly store: MailStore,
    private readonly sync: MailSyncService,
    private readonly analysis: MailAnalysisService,
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
      try {
        await this.analysis.analyzeBacklog(id);
      } catch (err) {
        this.logger.warn(`AI-анализ почты не удался mailbox=${id}: ${err instanceof Error ? err.name : 'unknown'}`);
      }
    }
  }
}

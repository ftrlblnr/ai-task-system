import { Module } from '@nestjs/common';
import { MailController } from './mail.controller';
import { MailConnectionService } from './mail-connection.service';
import { MailProviderRegistry } from './mail-provider.registry';
import { MailQueryService } from './mail-query.service';
import { MailStore } from './mail-store';
import { MailSyncCron } from './mail-sync.cron';
import { MailSyncService } from './mail-sync.service';
import { MailRuImapProvider } from './providers/mailru-imap.provider';

// Stage 2, Phase R — Mail.ru Email Intelligence. PrismaModule/CryptoModule глобальные
// (AppModule). Экспорты — для tools ассистента (MailQueryService/MailStore).
@Module({
  controllers: [MailController],
  providers: [MailStore, MailRuImapProvider, MailProviderRegistry, MailSyncService, MailConnectionService, MailSyncCron, MailQueryService],
  exports: [MailStore, MailQueryService],
})
export class MailModule {}

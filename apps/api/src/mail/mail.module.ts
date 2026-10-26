import { Module, OnModuleInit } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { TelegramModule } from '../telegram/telegram.module';
import { IdempotencyService } from '../common/idempotency.service';
import { MailController } from './mail.controller';
import { MailAnalysisService } from './mail-analysis.service';
import { MailConnectionService } from './mail-connection.service';
import { MailDigestCron } from './mail-digest.cron';
import { MailProviderRegistry } from './mail-provider.registry';
import { MailQueryService } from './mail-query.service';
import { MailStore } from './mail-store';
import { MailSyncCron } from './mail-sync.cron';
import { MailSyncService } from './mail-sync.service';
import { ImapMailProvider } from './providers/imap.provider';
import { SmtpSender } from './smtp-sender';
import { MailComposeService } from './mail-compose.service';
import { MailMessageActionsService } from './mail-message-actions.service';
import { MailActionController } from './action/mail-action.controller';
import { MailActionAnalysisService } from './action/mail-action-analysis.service';
import { MailActionApprovalService } from './action/mail-action-approval.service';
import { MailActionExecutionService } from './action/mail-action-execution.service';
import { MailActionExecutorRegistry } from './action/mail-action-executor';
import { MailActionPlanService } from './action/mail-action-plan.service';
import { MailActionSessionFactory } from './action/mail-action-session-factory';
import { registerStage1MailActionExecutors } from './action/executors/stage1-executors';
import { registerTriageMailActionExecutors } from './action/executors/triage-executors';
import { MailTriageController } from './triage/mail-triage.controller';
import { MailTriageService } from './triage/mail-triage.service';
import { TasksModule } from '../tasks/tasks.module';
import { TasksService } from '../tasks/tasks.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

// Stage 2, Phase R — Mail.ru Email Intelligence. PrismaModule/CryptoModule глобальные
// (AppModule). Экспорты — для tools ассистента (MailQueryService/MailStore).
// TelegramModule (Release 2) — MailDigestCron шлёт утреннюю сводку тем же
// TelegramBotService, что tasks/daily-digest.cron.ts. FilesModule (Release
// 2) — MailSyncService сохраняет байты вложений через FilesService
// (FileArtifact/FileStorage), тот же паттерн, что у чата/экспорта.
@Module({
  imports: [TelegramModule, FilesModule, TasksModule],
  controllers: [MailController, MailActionController, MailTriageController],
  providers: [
    MailStore,
    ImapMailProvider,
    SmtpSender,
    MailComposeService,
    MailMessageActionsService,
    MailProviderRegistry,
    MailSyncService,
    MailConnectionService,
    MailSyncCron,
    MailQueryService,
    MailAnalysisService,
    MailDigestCron,
    IdempotencyService,
    MailActionPlanService,
    MailActionAnalysisService,
    MailActionApprovalService,
    MailActionExecutionService,
    MailActionExecutorRegistry,
    MailActionSessionFactory,
    MailTriageService,
  ],
  exports: [MailStore, MailQueryService, MailActionExecutorRegistry, MailActionPlanService, MailComposeService],
})
export class MailModule implements OnModuleInit {
  constructor(
    private readonly executors: MailActionExecutorRegistry,
    private readonly prisma: PrismaService,
    private readonly store: MailStore,
    private readonly compose: MailComposeService,
    private readonly audit: AuditService,
    private readonly tasks: TasksService,
  ) {}

  // Этап 1 (раздел 3 ТЗ) — архив/перемещение/папки/флаги/прочитанность/
  // корзина. Регистрация здесь, не в конструкторе исполнителей — реестр
  // общий (#122), исполнители конкретного этапа не должны сами решать,
  // когда их подключать.
  onModuleInit(): void {
    registerStage1MailActionExecutors(this.executors);
    // Разбор почты (W4) — ответ и задача из письма.
    registerTriageMailActionExecutors(this.executors, { prisma: this.prisma, store: this.store, compose: this.compose, audit: this.audit, tasks: this.tasks });
  }
}

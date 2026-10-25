import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { CalendarModule } from '../calendar/calendar.module';
import { FilesModule } from '../files/files.module';
import { MailModule } from '../mail/mail.module';
import { MeetingsModule } from '../meetings/meetings.module';
import { EmployeesModule } from '../employees/employees.module';
import { LegalModule } from '../legal/legal.module';
import { MemoryModule } from '../memory/memory.module';
import { AssistantChatController } from './assistant-chat.controller';
import { AssistantChatService } from './assistant-chat.service';
import { AssistantReplyService } from './assistant-reply.service';
import { AssistantToolsService } from './assistant-tools.service';
import { LegalReviewNotifier } from './legal-review-notifier.service';
import { ConversationCompactionService } from './conversation-compaction.service';

@Module({
  // TasksModule/CalendarModule — AssistantToolsService читает через
  // TasksService/EventsService, тот же приём, что VoiceModule. FilesModule
  // (Phase F) — AssistantChatService проверяет владение вложениями через
  // FilesService.assertOwnedFile при отправке сообщения; AssistantToolsService
  // (Phase G) тем же FilesService создаёт сгенерированные файлы
  // (createGenerated) — отдельного импорта не требуется, FilesModule уже
  // экспортирует FilesService. MeetingsModule (Stage 2, Phase K) —
  // AssistantToolsService делегирует get_meeting в MeetingsService.findOne
  // (та же видимость/audit-логирование, что у REST /meetings).
  // EmployeesModule (Stage 2, Phase O) — AssistantToolsService.
  // create_task_from_meeting резолвит assigneeRawText через
  // EmployeeResolverService, тем же приёмом, что voice/updateSpeakers.
  // MailModule (Release 2) — search_emails/get_email читают через
  // MailQueryService/MailStore, экспортированные MailModule для этого же.
  // LegalModule — инструмент legal_ask (агент-юрист). MemoryModule — память
  // ассистента (ARMS, фаза 1): инструменты remember/recall/forget и индекс.
  imports: [TasksModule, CalendarModule, FilesModule, MailModule, MeetingsModule, EmployeesModule, LegalModule, MemoryModule],
  controllers: [AssistantChatController],
  providers: [AssistantChatService, AssistantReplyService, AssistantToolsService, LegalReviewNotifier, ConversationCompactionService],
  // AssistantChatService — Stage 2, Phase H: VoiceModule импортирует этот
  // модуль, чтобы писать голосовые реплики в ту же ленту через
  // getOrCreatePrimaryConversation, не дублируя её логику.
  // AssistantReplyService — hardening (22.09.2026, "voice ↔ text meeting
  // Q&A parity"): VoiceService для type:'chat'-черновиков строит ответ
  // тем же tool loop, что и текстовый чат (иначе голос не видел бы
  // Meeting/Plaud данные вообще — DraftExtractionService's контекст
  // ограничен tasks/events), не дублируя сам tool loop.
  // AssistantToolsService — MCP-сервер (McpModule) отдаёт те же инструменты Claude.
  exports: [AssistantChatService, AssistantReplyService, AssistantToolsService],
})
export class AssistantModule {}

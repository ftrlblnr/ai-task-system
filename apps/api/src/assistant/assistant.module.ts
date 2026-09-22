import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { CalendarModule } from '../calendar/calendar.module';
import { FilesModule } from '../files/files.module';
import { MeetingsModule } from '../meetings/meetings.module';
import { EmployeesModule } from '../employees/employees.module';
import { AssistantChatController } from './assistant-chat.controller';
import { AssistantChatService } from './assistant-chat.service';
import { AssistantReplyService } from './assistant-reply.service';
import { AssistantToolsService } from './assistant-tools.service';

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
  imports: [TasksModule, CalendarModule, FilesModule, MeetingsModule, EmployeesModule],
  controllers: [AssistantChatController],
  providers: [AssistantChatService, AssistantReplyService, AssistantToolsService],
  // AssistantChatService — Stage 2, Phase H: VoiceModule импортирует этот
  // модуль, чтобы писать голосовые реплики в ту же ленту через
  // getOrCreatePrimaryConversation, не дублируя её логику.
  // AssistantReplyService — hardening (22.09.2026, "voice ↔ text meeting
  // Q&A parity"): VoiceService для type:'chat'-черновиков строит ответ
  // тем же tool loop, что и текстовый чат (иначе голос не видел бы
  // Meeting/Plaud данные вообще — DraftExtractionService's контекст
  // ограничен tasks/events), не дублируя сам tool loop.
  exports: [AssistantChatService, AssistantReplyService],
})
export class AssistantModule {}

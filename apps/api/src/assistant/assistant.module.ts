import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { CalendarModule } from '../calendar/calendar.module';
import { FilesModule } from '../files/files.module';
import { AssistantChatController } from './assistant-chat.controller';
import { AssistantChatService } from './assistant-chat.service';
import { AssistantReplyService } from './assistant-reply.service';
import { AssistantToolsService } from './assistant-tools.service';

@Module({
  // TasksModule/CalendarModule — AssistantToolsService читает через
  // TasksService/EventsService, тот же приём, что VoiceModule. FilesModule
  // (Phase F) — AssistantChatService проверяет владение вложениями через
  // FilesService.assertOwnedFile при отправке сообщения.
  imports: [TasksModule, CalendarModule, FilesModule],
  controllers: [AssistantChatController],
  providers: [AssistantChatService, AssistantReplyService, AssistantToolsService],
})
export class AssistantModule {}

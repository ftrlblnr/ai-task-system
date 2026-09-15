import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { CalendarModule } from '../calendar/calendar.module';
import { AssistantChatController } from './assistant-chat.controller';
import { AssistantChatService } from './assistant-chat.service';
import { AssistantReplyService } from './assistant-reply.service';
import { AssistantToolsService } from './assistant-tools.service';

@Module({
  // TasksModule/CalendarModule — AssistantToolsService читает через
  // TasksService/EventsService, тот же приём, что VoiceModule.
  imports: [TasksModule, CalendarModule],
  controllers: [AssistantChatController],
  providers: [AssistantChatService, AssistantReplyService, AssistantToolsService],
})
export class AssistantModule {}

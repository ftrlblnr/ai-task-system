import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { CalendarModule } from '../calendar/calendar.module';
import { AssistantModule } from '../assistant/assistant.module';
import { EmployeesModule } from '../employees/employees.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { WhisperService } from './whisper.service';
import { DraftExtractionService } from './draft-extraction.service';

@Module({
  // TasksModule/CalendarModule — чтобы голосовой агент мог отвечать на
  // вопросы про статус задач/встречи, переиспользуя те же
  // TasksService.findAll/EventsService.findAll, что и обычные списки в
  // UI — те же правила видимости (кто что видит), без отдельной RBAC-копии.
  // AssistantModule (Stage 2, Phase H) — VoiceService пишет в ту же ленту
  // (Conversation/Message), что и текстовый чат, через
  // AssistantChatService.getOrCreatePrimaryConversation (экспортирован
  // оттуда специально для этого).
  // EmployeesModule (Stage 2, Phase I) — EmployeeResolverService для
  // независимой от LLM проверки assigneeRawText (см. VoiceService).
  imports: [TasksModule, CalendarModule, AssistantModule, EmployeesModule],
  controllers: [VoiceController],
  providers: [VoiceService, WhisperService, DraftExtractionService],
  // Stage 2, Phase Q — LiveModule исполняет делегации GPT-Live через
  // VoiceService.parseTranscript (тот же пайплайн, что голос, без STT).
  exports: [VoiceService],
})
export class VoiceModule {}

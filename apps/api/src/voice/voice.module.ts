import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { CalendarModule } from '../calendar/calendar.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';
import { WhisperService } from './whisper.service';
import { DraftExtractionService } from './draft-extraction.service';

@Module({
  // TasksModule/CalendarModule — чтобы голосовой агент мог отвечать на
  // вопросы про статус задач/встречи, переиспользуя те же
  // TasksService.findAll/EventsService.findAll, что и обычные списки в
  // UI — те же правила видимости (кто что видит), без отдельной RBAC-копии.
  imports: [TasksModule, CalendarModule],
  controllers: [VoiceController],
  providers: [VoiceService, WhisperService, DraftExtractionService],
})
export class VoiceModule {}

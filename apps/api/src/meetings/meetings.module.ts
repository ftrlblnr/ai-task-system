import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';
import { MeetingTaskExtractionService } from './meeting-task-extraction.service';
import { SpeakerSubstitutionService } from './speaker-substitution.service';

@Module({
  imports: [TasksModule],
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingTaskExtractionService, SpeakerSubstitutionService],
  exports: [MeetingsService],
})
export class MeetingsModule {}

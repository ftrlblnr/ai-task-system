import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { EmployeesModule } from '../employees/employees.module';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';
import { MeetingTaskExtractionService } from './meeting-task-extraction.service';
import { SpeakerSubstitutionService } from './speaker-substitution.service';
import { MeetingAnalysisService } from './meeting-analysis.service';
import { MeetingAnalysisExecutionService } from './meeting-analysis-execution.service';
import { MeetingSpeakersService } from './meeting-speakers.service';
import { MeetingProposalsService } from './meeting-proposals.service';
import { IdempotencyService } from '../common/idempotency.service';

@Module({
  // EmployeesModule (Stage 2, Phase L, находка №7 пятого аудита) —
  // EmployeeResolverService для сопоставления Meeting.speakerNames с
  // реальными сотрудниками, см. MeetingsService.updateSpeakers.
  imports: [TasksModule, EmployeesModule],
  controllers: [MeetingsController],
  providers: [
    MeetingsService,
    MeetingTaskExtractionService,
    SpeakerSubstitutionService,
    MeetingAnalysisService,
    MeetingAnalysisExecutionService,
    MeetingSpeakersService,
    MeetingProposalsService,
    IdempotencyService,
  ],
  // MeetingAnalysisService — для инструмента ассистента analyze_meeting (B5).
  exports: [MeetingsService, MeetingAnalysisService, MeetingProposalsService],
})
export class MeetingsModule {}

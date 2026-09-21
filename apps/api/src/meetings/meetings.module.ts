import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { EmployeesModule } from '../employees/employees.module';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';
import { MeetingTaskExtractionService } from './meeting-task-extraction.service';
import { SpeakerSubstitutionService } from './speaker-substitution.service';

@Module({
  // EmployeesModule (Stage 2, Phase L, находка №7 пятого аудита) —
  // EmployeeResolverService для сопоставления Meeting.speakerNames с
  // реальными сотрудниками, см. MeetingsService.updateSpeakers.
  imports: [TasksModule, EmployeesModule],
  controllers: [MeetingsController],
  providers: [MeetingsService, MeetingTaskExtractionService, SpeakerSubstitutionService],
  exports: [MeetingsService],
})
export class MeetingsModule {}

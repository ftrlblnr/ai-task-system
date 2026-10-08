import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { CalendarModule } from '../calendar/calendar.module';
import { TasksModule } from '../tasks/tasks.module';
import { IdempotencyService } from '../common/idempotency.service';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { TripRightsService } from './trip-rights.service';
import { TripExtractionService } from './trip-extraction.service';
import { TripRunExecutionService } from './trip-run-execution.service';
import { TripChangesService } from './trip-changes.service';
import { TripEditService } from './trip-edit.service';
import { TripMembersService } from './trip-members.service';
import { TripIntegrationsService } from './trip-integrations.service';

@Module({
  imports: [AuthModule, FilesModule, CalendarModule, TasksModule],
  controllers: [TripsController],
  providers: [
    TripsService,
    TripRightsService,
    TripExtractionService,
    TripRunExecutionService,
    TripChangesService,
    TripEditService,
    TripMembersService,
    TripIntegrationsService,
    IdempotencyService,
  ],
})
export class TripsModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { IdempotencyService } from '../common/idempotency.service';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { TripRightsService } from './trip-rights.service';
import { TripExtractionService } from './trip-extraction.service';
import { TripRunExecutionService } from './trip-run-execution.service';

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [TripsController],
  providers: [TripsService, TripRightsService, TripExtractionService, TripRunExecutionService, IdempotencyService],
})
export class TripsModule {}

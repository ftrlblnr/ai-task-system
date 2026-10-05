import { Module } from '@nestjs/common';
import { ReceptionModule } from '../reception/reception.module';
import { CalendarModule } from '../calendar/calendar.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [ReceptionModule, CalendarModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}

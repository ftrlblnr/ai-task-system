import { Module } from '@nestjs/common';
import { ReceptionModule } from '../reception/reception.module';
import { CalendarModule } from '../calendar/calendar.module';
import { TasksModule } from '../tasks/tasks.module';
import { MailModule } from '../mail/mail.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { DashboardPanelsService } from './dashboard-panels.service';

@Module({
  imports: [ReceptionModule, CalendarModule, TasksModule, MailModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardPanelsService],
})
export class DashboardModule {}

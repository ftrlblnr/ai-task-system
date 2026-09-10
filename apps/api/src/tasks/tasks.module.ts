import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksOverdueCron } from './tasks-overdue.cron';
import { DailyDigestCron } from './daily-digest.cron';

@Module({
  imports: [TelegramModule],
  controllers: [TasksController],
  providers: [TasksService, TasksOverdueCron, DailyDigestCron],
  exports: [TasksService],
})
export class TasksModule {}

import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { ReceptionController } from './reception.controller';
import { ReceptionService } from './reception.service';
import { IdempotencyService } from './idempotency.service';
import { ActiveEmployeeGuard } from './guards/active-employee.guard';
import { ReceptionNotificationsCron } from './reception-notifications.cron';

@Module({
  imports: [TelegramModule],
  controllers: [ReceptionController],
  providers: [ReceptionService, IdempotencyService, ActiveEmployeeGuard, ReceptionNotificationsCron],
  // «Стол руководителя» (владелец 05.10.2026) — DashboardService переиспользует
  // getQueueView() напрямую, без второй реализации очереди на главной.
  exports: [ReceptionService],
})
export class ReceptionModule {}

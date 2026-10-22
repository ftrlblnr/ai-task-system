import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { EmployeesModule } from '../employees/employees.module';
import { FilesModule } from '../files/files.module';
import { ReceptionController } from './reception.controller';
import { ReceptionChangedInterceptor } from './reception-changed.interceptor';
import { AnswerStructuringService } from './answer-structuring.service';
import { ReceptionService } from './reception.service';
import { IdempotencyService } from '../common/idempotency.service';
import { ActiveEmployeeGuard } from './guards/active-employee.guard';
import { ReceptionNotificationsCron } from './reception-notifications.cron';
import { WhisperService } from '../voice/whisper.service';

@Module({
  imports: [TelegramModule, EmployeesModule, FilesModule],
  controllers: [ReceptionController],
  // WhisperService — голосовой ответ руководителя (только ConfigService в
  // зависимостях, весь VoiceModule не нужен).
  providers: [ReceptionChangedInterceptor, ReceptionService, IdempotencyService, ActiveEmployeeGuard, ReceptionNotificationsCron, WhisperService, AnswerStructuringService],
  // «Стол руководителя» (владелец 05.10.2026) — DashboardService переиспользует
  // getQueueView() напрямую, без второй реализации очереди на главной.
  exports: [ReceptionService],
})
export class ReceptionModule {}

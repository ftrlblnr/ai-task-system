import { Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { IdempotencyService } from '../common/idempotency.service';
import { CalendarActionController } from './action/calendar-action.controller';
import { CalendarActionExecutionService } from './action/calendar-action-execution.service';
import { CalendarActionExecutorRegistry } from './action/calendar-action-executor';
import { CalendarAuthorizationService } from './action/calendar-authorization.service';
import { CalendarPlanService } from './action/calendar-plan.service';
import { registerCalendarActionExecutors } from './action/executors/register-calendar-executors';
import { CalendarAvailabilityService } from './calendar-availability.service';
import { CalendarPolicyService } from './calendar-policy.service';
import { CalendarController, GoogleCalendarPublicController } from './calendar.controller';
import { EventsService } from './events.service';
import { GoogleFreeBusyService } from './google-freebusy.service';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { CalendarSyncCron } from './calendar-sync.cron';

@Module({
  // AuthModule — JwtModule (state-токен для OAuth callback). TelegramModule
  // — уведомления участникам встреч (владелец 09.09.2026).
  imports: [AuthModule, TelegramModule],
  controllers: [CalendarController, CalendarActionController, GoogleCalendarPublicController],
  providers: [
    EventsService,
    GoogleOAuthService,
    GoogleCalendarSyncService,
    CalendarSyncCron,
    IdempotencyService,
    CalendarAvailabilityService,
    CalendarPolicyService,
    GoogleFreeBusyService,
    CalendarPlanService,
    CalendarAuthorizationService,
    CalendarActionExecutionService,
    CalendarActionExecutorRegistry,
  ],
  exports: [EventsService],
})
export class CalendarModule implements OnModuleInit {
  constructor(
    private readonly executors: CalendarActionExecutorRegistry,
    private readonly events: EventsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // Раздел 6 ТЗ (CREATE_EVENT/UPDATE_EVENT/RESCHEDULE_EVENT/CANCEL_EVENT) —
  // регистрация здесь, не в конструкторе исполнителей, тот же принцип, что
  // MailModule.onModuleInit.
  onModuleInit(): void {
    registerCalendarActionExecutors(this.executors, this.events, this.idempotency);
  }
}

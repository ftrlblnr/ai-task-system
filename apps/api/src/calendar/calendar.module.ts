import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramModule } from '../telegram/telegram.module';
import { IdempotencyService } from '../common/idempotency.service';
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
  controllers: [CalendarController, GoogleCalendarPublicController],
  providers: [
    EventsService,
    GoogleOAuthService,
    GoogleCalendarSyncService,
    CalendarSyncCron,
    IdempotencyService,
    CalendarAvailabilityService,
    CalendarPolicyService,
    GoogleFreeBusyService,
  ],
  exports: [EventsService],
})
export class CalendarModule {}

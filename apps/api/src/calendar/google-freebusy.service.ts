import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleOAuthService } from './google-oauth.service';
import type { BusyInterval } from './calendar-availability';

export type FreeBusyResult = { status: 'OK'; busy: BusyInterval[] } | { status: 'UNAVAILABLE' };

// Календарный агент, раздел 11 ТЗ — "недоступность одного обязательного
// источника даёт UNKNOWN, а не пустой busy-массив": любая ошибка здесь
// превращается в UNAVAILABLE, НЕ бросается наверх и НЕ трактуется как
// "свободно" — вызывающий код (CalendarAvailabilityService) обязан
// показать это как неопределённость, не подтверждать бронь на этом
// основании.
@Injectable()
export class GoogleFreeBusyService {
  private readonly logger = new Logger(GoogleFreeBusyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: GoogleOAuthService,
  ) {}

  async queryBusy(employeeId: string, from: Date, to: Date): Promise<FreeBusyResult> {
    try {
      const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { employeeId } });
      if (!connection) return { status: 'UNAVAILABLE' };

      const auth = await this.oauth.getAuthorizedClient(employeeId);
      const calendar = google.calendar({ version: 'v3', auth });
      const response = await calendar.freebusy.query({
        requestBody: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: connection.calendarId }] },
      });

      const busyRaw = response.data.calendars?.[connection.calendarId]?.busy ?? [];
      const busy: BusyInterval[] = [];
      for (const b of busyRaw) {
        if (!b.start || !b.end) continue;
        busy.push({ start: new Date(b.start), end: new Date(b.end) });
      }
      return { status: 'OK', busy };
    } catch (err) {
      this.logger.warn(`freeBusy запрос не удался для ${employeeId}: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 'UNAVAILABLE' };
    }
  }
}

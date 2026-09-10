import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';

// Push-канал (events.watch) живёт ограниченное время и требует продления;
// периодический pull — подстраховка на случай пропущенного webhook'а
// (раздел 22 ТЗ: не полагаться на единственный механизм доставки).
@Injectable()
export class CalendarSyncCron {
  private readonly logger = new Logger(CalendarSyncCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: GoogleCalendarSyncService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async renewExpiringChannels() {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const connections = await this.prisma.googleCalendarConnection.findMany({
      where: { OR: [{ channelExpiresAt: null }, { channelExpiresAt: { lt: soon } }] },
      select: { employeeId: true },
    });

    for (const { employeeId } of connections) {
      try {
        await this.sync.ensureWatchChannel(employeeId);
      } catch (err) {
        this.logger.warn(`Не удалось продлить канал push-уведомлений для ${employeeId}: ${err}`);
      }
    }
  }

  @Cron('0 */15 * * * *')
  async fallbackPull() {
    const connections = await this.prisma.googleCalendarConnection.findMany({ select: { employeeId: true } });
    for (const { employeeId } of connections) {
      try {
        await this.sync.pullChanges(employeeId);
      } catch (err) {
        this.logger.warn(`Фоновая синхронизация календаря не удалась для ${employeeId}: ${err}`);
      }
    }
  }
}

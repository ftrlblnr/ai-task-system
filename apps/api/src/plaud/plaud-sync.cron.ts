import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PlaudSyncService } from './plaud-sync.service';

// Встречи не настолько срочны, как события календаря — 30 минут вместо
// 15-минутного fallback-пула Google Calendar достаточно (у Plaud вдобавок
// нет push-уведомлений, только периодический pull).
@Injectable()
export class PlaudSyncCron {
  private readonly logger = new Logger(PlaudSyncCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: PlaudSyncService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async pullAll() {
    const connections = await this.prisma.plaudConnection.findMany({ select: { employeeId: true } });
    for (const { employeeId } of connections) {
      try {
        await this.sync.pullChanges(employeeId);
      } catch (err) {
        this.logger.warn(`Фоновая синхронизация Plaud не удалась для ${employeeId}: ${err}`);
      }
    }
  }
}

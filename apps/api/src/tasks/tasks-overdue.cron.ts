import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';

// Аудит 10.09.2026, п. 2.1: раньше этот крон каждые 30 минут переводил
// задачу в статус OVERDUE — включая те, что сотрудник только что взял в
// работу (IN_PROGRESS/IN_REVIEW), перетирая его обратно при следующем
// прогоне, плюс лишняя запись в TaskHistory каждый раз. Просрочка теперь не
// хранимый статус, а вычисляемый признак (см. isTaskOverdue в
// tasks.service.ts) — этот крон только уведомляет, один раз на факт
// просрочки (overdueNotifiedAt), статус задачи не трогает вообще.
@Injectable()
export class TasksOverdueCron {
  private readonly logger = new Logger(TasksOverdueCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async notifyOverdue() {
    const tasks = await this.prisma.task.findMany({
      where: {
        dueDate: { lt: new Date() },
        status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] },
        overdueNotifiedAt: null,
      },
      select: {
        id: true,
        title: true,
        assignee: { select: { telegramId: true } },
      },
    });

    for (const task of tasks) {
      try {
        await this.prisma.task.update({
          where: { id: task.id },
          data: { overdueNotifiedAt: new Date() },
        });
        void this.bot.sendMessage(task.assignee?.telegramId, `Задача «${task.title}» просрочена`);
      } catch (err) {
        this.logger.warn(`Не удалось пометить задачу ${task.id} уведомлённой о просрочке: ${err}`);
      }
    }
  }
}

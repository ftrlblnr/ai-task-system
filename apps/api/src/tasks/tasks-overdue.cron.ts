import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';

// Владелец 08.09.2026: статус OVERDUE есть в схеме и уже подключён во
// фронтенде (отдельная колонка на канбане, красный цвет), но ничего в
// бэкенде никогда не выставляло его — колонка была всегда пуста. По
// образцу единственного существующего крона в проекте
// (calendar-sync.cron.ts) — @Cron + Logger + for...of с try/catch на
// запись, ни одна ошибка не прерывает остальной батч.
@Injectable()
export class TasksOverdueCron {
  private readonly logger = new Logger(TasksOverdueCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: TelegramBotService,
  ) {}

  // Каждые 30 минут — то, что напрямую видно на доске, чаще, чем фоновый
  // 15-минутный fallback-pull календаря, но не настолько часто, чтобы
  // нагружать VPS.
  @Cron(CronExpression.EVERY_30_MINUTES)
  async markOverdue() {
    const tasks = await this.prisma.task.findMany({
      where: {
        dueDate: { lt: new Date() },
        status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED, TaskStatus.OVERDUE] },
      },
      select: {
        id: true,
        title: true,
        status: true,
        assignee: { select: { telegramId: true } },
      },
    });

    for (const task of tasks) {
      try {
        await this.prisma.$transaction([
          this.prisma.task.update({ where: { id: task.id }, data: { status: TaskStatus.OVERDUE } }),
          this.prisma.taskHistory.create({
            data: {
              taskId: task.id,
              // changedById не указан — системное изменение, не от живого
              // актора (TaskHistory.changedById специально сделан nullable
              // ради этого случая).
              field: 'status',
              oldValue: task.status,
              newValue: TaskStatus.OVERDUE,
            },
          }),
        ]);
        void this.bot.sendMessage(task.assignee?.telegramId, `Задача «${task.title}» просрочена`);
      } catch (err) {
        this.logger.warn(`Не удалось пометить задачу ${task.id} просроченной: ${err}`);
      }
    }
  }
}

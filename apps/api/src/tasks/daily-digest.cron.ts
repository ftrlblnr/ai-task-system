import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EmployeeStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { TasksService } from './tasks.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

// Владелец 08.09.2026 (по итогам аудита best-practices): один компактный
// дайджест в фиксированное время вместо разрозненных пушей — снижает
// усталость от переключения контекста сильнее, чем поток уведомлений
// (см. записку «От трекера к разгрузке»). Если сотруднику нечего
// сообщить — сообщение не шлётся вообще, без шума ради самого факта
// присутствия функции.
@Injectable()
export class DailyDigestCron {
  private readonly logger = new Logger(DailyDigestCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly bot: TelegramBotService,
  ) {}

  // '0 0 3 * * *' — 3:00 UTC = 8:00 Алматы (сервер всегда в UTC — тот же
  // сдвиг TIMEZONE_OFFSET_HOURS=5, что уже используется голосовым агентом
  // в draft-extraction.service.ts).
  @Cron('0 0 3 * * *')
  async sendDigest() {
    const employees = await this.prisma.employee.findMany({
      where: { status: EmployeeStatus.ACTIVE, telegramId: { not: null } },
      select: { id: true, email: true, role: true, telegramId: true },
    });

    for (const employee of employees) {
      try {
        const actor: AuthenticatedUser = {
          id: employee.id,
          email: employee.email,
          role: employee.role,
          isProfileAdmin: false,
        };
        const allTasks = await this.tasks.findAll(actor);

        // Просрочка — вычисляемый признак (isOverdue от TasksService), не
        // статус, см. аудит 10.09.2026 п. 2.1.
        const overdue = allTasks.filter((t) => t.isOverdue);
        const today = new Date();
        const dueToday = allTasks.filter(
          (t) =>
            !t.isOverdue &&
            t.status !== 'DONE' &&
            t.status !== 'CANCELLED' &&
            t.dueDate &&
            new Date(t.dueDate).toDateString() === today.toDateString(),
        );
        // Только руководителю — задачи, которые сам голосовой агент
        // пометил низкой уверенностью разбора, стоит перепроверить.
        const needsReview =
          employee.role === Role.OWNER ? allTasks.filter((t) => t.aiConfidence === 'LOW') : [];

        if (overdue.length === 0 && dueToday.length === 0 && needsReview.length === 0) continue;

        const lines: string[] = ['Доброе утро! Коротко на сегодня:'];
        if (overdue.length > 0) {
          lines.push('', `Просрочено (${overdue.length}):`, ...overdue.map((t) => `• ${t.title}`));
        }
        if (dueToday.length > 0) {
          lines.push('', `Срок сегодня (${dueToday.length}):`, ...dueToday.map((t) => `• ${t.title}`));
        }
        if (needsReview.length > 0) {
          lines.push(
            '',
            `Стоит перепроверить (${needsReview.length}):`,
            ...needsReview.map((t) => `• ${t.title}`),
          );
        }

        void this.bot.sendMessage(employee.telegramId, lines.join('\n'));
      } catch (err) {
        this.logger.warn(`Не удалось собрать дайджест для ${employee.id}: ${err}`);
      }
    }
  }
}

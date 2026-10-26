import { Injectable, Logger } from '@nestjs/common';
import { isManager } from '../auth/roles';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { DataOwner } from '../auth/data-owner';
import { TasksService } from '../tasks/tasks.service';
import { ReceptionService } from '../reception/reception.service';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { MailStore } from '../mail/mail-store';
import { MailTriageService } from '../mail/triage/mail-triage.service';

// Бейджи меню (редизайн web W5, docs/WEB_REDESIGN.md §4.1): одним лёгким
// запросом, без модели. Каждая цифра — тем же сервисом и с теми же правами,
// что у раздела; null — раздел недоступен роли, почта не подключена или
// источник не ответил (бейдж просто не показывается).

export interface MenuBadges {
  tasksOverdue: number | null;
  receptionWaiting: number | null;
  mailNeedsReply: number | null;
  recommendationsNew: number | null;
}

@Injectable()
export class BadgesService {
  private readonly logger = new Logger(BadgesService.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly reception: ReceptionService,
    private readonly recommendations: RecommendationsService,
    private readonly mailStore: MailStore,
    private readonly triage: MailTriageService,
  ) {}

  async forUser(user: AuthenticatedUser, owner: DataOwner, mailboxId?: string): Promise<MenuBadges> {
    const manager = isManager(user.role);
    const [tasksOverdue, receptionWaiting, mailNeedsReply, recommendationsNew] = await Promise.all([
      this.safe('tasks', () => this.tasks.overdueCount()),
      manager ? this.safe('reception', () => this.reception.waitingCount()) : null,
      manager ? this.safe('mail', () => this.mailNeedsReply(owner.id, mailboxId)) : null,
      manager ? this.safe('recommendations', () => this.recommendations.newCount(user.id)) : null,
    ]);
    return { tasksOverdue, receptionWaiting, mailNeedsReply, recommendationsNew };
  }

  // Почта — ящик, выбранный на /mail (X-Mailbox-Id), иначе первый; для
  // администратора в режиме руководителя — ящик руководителя.
  private async mailNeedsReply(ownerId: string, mailboxId?: string): Promise<number | null> {
    let mailbox = await this.mailStore.findOwnedMailbox(ownerId, mailboxId);
    // Сохранённый на клиенте ящик мог остаться от другого режима — тогда первый.
    if (!mailbox && mailboxId) mailbox = await this.mailStore.findOwnedMailbox(ownerId);
    if (!mailbox) return null;
    return (await this.triage.summary(mailbox.id, 0)).needsReply;
  }

  private async safe(label: string, run: () => Promise<number | null>): Promise<number | null> {
    try {
      return await run();
    } catch (err) {
      this.logger.warn(`badges: ${label} failed: ${err instanceof Error ? err.name : 'unknown'}`);
      return null;
    }
  }
}

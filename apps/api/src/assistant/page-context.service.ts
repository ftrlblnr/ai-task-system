import { Injectable, Logger } from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../calendar/events.service';
import { MeetingsService } from '../meetings/meetings.service';
import { MailQueryService } from '../mail/mail-query.service';
import { MailStore } from '../mail/mail-store';
import { AuditService } from '../audit/audit.service';
import { isManager } from '../auth/roles';
import { formatLocalDateTime } from '../common/timezone';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { PageContextDto } from './dto/send-message.dto';

// Редизайн web W2 (docs/WEB_REDESIGN.md §4.2) — «на что смотрит
// пользователь» для панели агента. Клиент присылает только вид и id —
// подсказку; сущность загружается здесь тем же сервисом и с теми же
// правами, что у раздела: задачи видны всем (владелец 20.10.2026),
// календарь/встречи/почта — только руководству, событие — только своё
// (EventsService.findOne по владельцу), письмо — только из своих ящиков.
// Нет прав, нет сущности, любая ошибка — контекст молча не добавляется.

const TEXT_LIMIT = 1500;
const DESCRIPTION_LIMIT = 600;

function clip(text: string | null | undefined, limit: number): string | null {
  const value = text?.trim();
  if (!value) return null;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function line(
  label: string,
  value: string | number | null | undefined,
): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : `${label}: ${value}`;
}

function at(date: Date | null | undefined): string | null {
  return date ? formatLocalDateTime(date) : null;
}

const LIST_ROUTE_LABELS: Record<string, string> = {
  '/tasks': 'задачи',
  '/reception': 'приёмная',
  '/trips': 'поездки',
  '/calendar': 'календарь',
  '/meetings': 'встречи',
  '/mail': 'почта',
  '/memory': 'память ассистента',
  '/skills': 'навыки',
  '/routines': 'регламенты',
  '/recommendations': 'рекомендации',
  '/ai-usage': 'расход ИИ',
  '/employees': 'сотрудники',
  '/legal': 'юрист',
};

@Injectable()
export class PageContextService {
  private readonly logger = new Logger(PageContextService.name);

  constructor(
    private readonly tasks: TasksService,
    private readonly events: EventsService,
    private readonly meetings: MeetingsService,
    private readonly mailQuery: MailQueryService,
    private readonly mailStore: MailStore,
    private readonly audit: AuditService,
  ) {}

  async describe(
    user: AuthenticatedUser,
    context: PageContextDto | undefined,
  ): Promise<string | null> {
    if (!context) return null;
    try {
      const lines = await this.load(user, context);
      const text = lines?.filter((l): l is string => Boolean(l)).join('\n');
      return text || null;
    } catch (err) {
      // NotFound/чужое — штатно, не шумим в логах на уровне warn.
      this.logger.debug(
        `page context ${context.kind} skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async load(
    user: AuthenticatedUser,
    context: PageContextDto,
  ): Promise<(string | null)[] | null> {
    switch (context.kind) {
      case 'dashboard':
        return user.role === 'OWNER'
          ? [
              'Пользователь на «Пульте» — сводка дня: задачи, приёмная, календарь, почта.',
            ]
          : null;
      case 'list': {
        const route = context.route ?? '';
        const label = LIST_ROUTE_LABELS[route];
        if (!label) return null;
        return [
          `Пользователь смотрит раздел «${label}».`,
          line('Фильтр', clip(context.filter, 200)),
        ];
      }
      case 'task':
        return context.id ? this.task(context.id) : null;
      case 'mail':
        return context.id && isManager(user.role)
          ? this.mail(user, context.id)
          : null;
      case 'event':
        return context.id && isManager(user.role)
          ? this.event(user, context.id)
          : null;
      case 'meeting':
        return context.id && isManager(user.role)
          ? this.meeting(user, context.id)
          : null;
      default:
        return null;
    }
  }

  private async task(id: string): Promise<(string | null)[]> {
    const t = await this.tasks.findOne(id);
    return [
      'Пользователь смотрит задачу.',
      line('id', t.id),
      line('Название', t.title),
      line('Статус', t.status),
      line('Приоритет', t.priority),
      line('Исполнитель', t.assignee?.fullName ?? 'не назначен'),
      line('Постановщик', t.creator?.fullName),
      line('Срок', at(t.dueDate)),
      line(
        'Подзадачи',
        t.subtaskCount
          ? `${t.subtaskDoneCount}/${t.subtaskCount} готово`
          : null,
      ),
      line('Родительская задача', t.parentTask?.title),
      line('Описание', clip(t.description, DESCRIPTION_LIMIT)),
    ];
  }

  private async mail(
    user: AuthenticatedUser,
    id: string,
  ): Promise<(string | null)[] | null> {
    const mailboxes = await this.mailStore.listMailboxesByEmployee(user.id);
    if (mailboxes.length === 0) return null;
    const m = await this.mailQuery.getMessage(
      mailboxes.map((b) => b.id),
      id,
    );
    await this.audit.log(user.id, 'AI_MAIL_READ', 'EmailMessage', id, {
      source: 'page_context',
    });
    return [
      'Пользователь смотрит письмо.',
      line('emailId', m.id),
      line('Тема', m.subject),
      line(
        'От',
        m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
      ),
      line('Получено', at(m.receivedAt)),
      line('Кратко', m.analysis?.summary),
      line('Нужен ответ', m.analysis?.needsReply ? 'да' : null),
      line('Что сделать', m.analysis?.actionSummary),
      line('Текст', clip(m.textBody, TEXT_LIMIT)),
    ];
  }

  private async event(
    user: AuthenticatedUser,
    id: string,
  ): Promise<(string | null)[]> {
    const e = await this.events.findOne(id, user.id);
    return [
      'Пользователь смотрит событие календаря.',
      line('eventId', e.id),
      line('Название', e.title),
      line('Начало', at(e.startAt)),
      line('Конец', at(e.endAt)),
      line('Место', e.location),
      line('Участники', e.participants.map((p) => p.fullName).join(', ')),
      line('Описание', clip(e.description, DESCRIPTION_LIMIT)),
    ];
  }

  private async meeting(
    user: AuthenticatedUser,
    id: string,
  ): Promise<(string | null)[]> {
    const m = await this.meetings.findOne(id, user.id);
    return [
      'Пользователь смотрит встречу (протокол).',
      line('meetingId', m.id),
      line('Название', m.title),
      line('Дата', at(m.meetingDate)),
      line(
        'Саммари',
        clip(m.enhancedSummary ?? m.latestSummary ?? m.rawSummary, TEXT_LIMIT),
      ),
    ];
  }
}

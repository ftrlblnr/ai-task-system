import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventSource, EventStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { GoogleCalendarSyncService } from './google-calendar-sync.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

const PARTICIPANTS_INCLUDE = {
  participants: { select: { employee: { select: { id: true, fullName: true } } } },
} as const;

function withParticipants<T extends { participants: { employee: { id: string; fullName: string } }[] }>(
  event: T,
) {
  const { participants, ...rest } = event;
  return { ...rest, participants: participants.map((p) => p.employee) };
}

// Календарь руководителя (раздел 14.2 ТЗ / Адъютант, 28.08.2026) — не
// общий корпоративный календарь, а личный календарь руководителя внутри
// системы, поэтому CRUD не проверяет видимость по assignee/creator, как
// задачи — доступ к этому модулю целиком ограничен ролью OWNER на уровне
// контроллера (@Roles(Role.OWNER)).
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: GoogleCalendarSyncService,
    private readonly bot: TelegramBotService,
  ) {}

  async findAll(employeeId: string) {
    const events = await this.prisma.event.findMany({
      where: { createdById: employeeId },
      orderBy: { startAt: 'asc' },
      include: PARTICIPANTS_INCLUDE,
    });
    return events.map(withParticipants);
  }

  async findOne(id: string) {
    const event = await this.prisma.event.findUnique({ where: { id }, include: PARTICIPANTS_INCLUDE });
    if (!event) throw new NotFoundException('Событие не найдено');
    return withParticipants(event);
  }

  async create(dto: CreateEventDto, employeeId: string) {
    const event = await this.prisma.event.create({
      data: {
        title: dto.title,
        description: dto.description,
        location: dto.location,
        startAt: new Date(dto.startAt),
        endAt: new Date(dto.endAt),
        allDay: dto.allDay ?? false,
        status: dto.status ?? EventStatus.CONFIRMED,
        lastModifiedBy: EventSource.INTERNAL,
        createdById: employeeId,
      },
    });

    await this.pushBestEffort(employeeId, event.id);
    return this.findOne(event.id);
  }

  async update(id: string, dto: UpdateEventDto, employeeId: string) {
    await this.findOne(id);
    await this.prisma.event.update({
      where: { id },
      data: {
        ...dto,
        startAt: dto.startAt ? new Date(dto.startAt) : undefined,
        endAt: dto.endAt ? new Date(dto.endAt) : undefined,
        lastModifiedBy: EventSource.INTERNAL,
      },
    });

    await this.pushBestEffort(employeeId, id);
    return this.findOne(id);
  }

  // Участники встречи (владелец 09.09.2026) — весь модуль и так закрыт на
  // OWNER, отдельной RBAC-проверки здесь не нужно (тот же принцип, что у
  // TasksService.addWatcher/removeWatcher, только без варианта "сам на
  // себя" — участников встречи назначает только руководитель).
  async addParticipant(eventId: string, employeeId: string) {
    await this.findOne(eventId); // 404, если встречи нет
    await this.prisma.eventParticipant.upsert({
      where: { eventId_employeeId: { eventId, employeeId } },
      create: { eventId, employeeId },
      update: {},
    });

    const event = await this.findOne(eventId);
    const when = event.startAt.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    void this.prisma.employee
      .findUnique({ where: { id: employeeId }, select: { telegramId: true } })
      .then((emp) => this.bot.sendMessage(emp?.telegramId, `Вы приглашены на встречу «${event.title}» (${when})`));

    return event;
  }

  async removeParticipant(eventId: string, employeeId: string) {
    await this.findOne(eventId); // 404, если встречи нет
    await this.prisma.eventParticipant.deleteMany({ where: { eventId, employeeId } });
    return this.findOne(eventId);
  }

  async remove(id: string, employeeId: string) {
    const event = await this.findOne(id);
    if (event.googleEventId) {
      try {
        await this.sync.deleteFromGoogle(employeeId, event.googleEventId);
      } catch (err) {
        this.logger.warn(`Не удалось удалить событие ${id} в Google Calendar: ${err}`);
      }
    }
    await this.prisma.event.delete({ where: { id } });
  }

  // Синхронизация с Google — best-effort: если календарь не подключён или
  // Google API временно недоступен, локальная задача/событие всё равно
  // должны создаваться — руководитель не должен терять работу из-за сбоя
  // внешней интеграции.
  private async pushBestEffort(employeeId: string, eventId: string) {
    try {
      await this.sync.pushEvent(employeeId, eventId);
    } catch (err) {
      this.logger.warn(`Не удалось синхронизировать событие ${eventId} с Google Calendar: ${err}`);
    }
  }
}

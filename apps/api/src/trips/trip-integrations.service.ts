import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { EventsService } from '../calendar/events.service';
import { TasksService } from '../tasks/tasks.service';
import { TripRightsService } from './trip-rights.service';
import { ProposeTripTaskDto } from './dto/propose-trip-task.dto';

// Приоритет 3 ТЗ, раздел 10 — интеграции отдельные от просмотра/правки
// самой поездки: calendar.write/tasks.assign — отдельные права, не
// подразумеваются trips.edit. Билеты/отели/платежи — явно вне MVP (раздел
// 10 ТЗ: "агент организует информацию и подготовку, никогда не обещает
// выполнить покупку") — здесь не реализуются вовсе, не только отложены.
@Injectable()
export class TripIntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rights: TripRightsService,
    private readonly events: EventsService,
    private readonly tasks: TasksService,
  ) {}

  // Личный календарь в этом проекте есть только у OWNER (CalendarController
  // целиком под @Roles(OWNER)) — добавление события доступно только ему,
  // не любому участнику поездки с правом edit. Если TripEvent не имеет
  // точного времени начала/окончания — отказ, а не выдуманный час (тот же
  // принцип, что весь остальной модуль).
  async addEventToCalendar(user: AuthenticatedUser, tripId: string, eventId: string) {
    await this.rights.assertPermission(tripId, user.id, 'view');
    if (user.role !== 'OWNER') {
      throw new ForbiddenException('CALENDAR_OWNER_ONLY: личный календарь есть только у руководителя');
    }
    const event = await this.prisma.tripEvent.findUnique({ where: { id: eventId } });
    if (!event || event.tripId !== tripId) throw new NotFoundException('Событие поездки не найдено');
    if (!event.startAt || !event.endAt) {
      throw new BadRequestException('NEEDS_EXACT_TIME: нужны точные время начала и окончания — дополните вручную перед добавлением в календарь');
    }

    const created = await this.events.create(
      { title: event.title, description: event.notes ?? undefined, location: event.location ?? undefined, startAt: event.startAt.toISOString(), endAt: event.endAt.toISOString() },
      user.id,
    );
    await this.prisma.tripRevision.create({
      data: { tripId, entityType: 'TRIP_EVENT', entityId: eventId, summary: `Событие «${event.title}» добавлено в личный календарь`, appliedByEmployeeId: user.id },
    });
    return created;
  }

  // Раздел 10 ТЗ — "предложить задачу, создать только с разрешения, с
  // исполнителем и сроком, никогда не изобретая отсутствующие параметры":
  // assigneeId/dueDate здесь обязательны на уровне самого вызова, не
  // опциональны, как в общем TasksService.create.
  async proposeTask(user: AuthenticatedUser, tripId: string, dto: ProposeTripTaskDto) {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    const task = await this.tasks.create({ title: dto.title, assigneeId: dto.assigneeId, dueDate: dto.dueDate, sourceContext: `Создано из поездки (humanCode см. GET /trips/${tripId})` }, user);
    await this.prisma.tripRevision.create({
      data: { tripId, entityType: 'TRIP', entityId: null, summary: `Создана задача «${dto.title}»`, appliedByEmployeeId: user.id },
    });
    return task;
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { TripRightsService } from './trip-rights.service';
import { UpdateTripDto } from './dto/update-trip.dto';
import { UpdateTripLegDto } from './dto/update-trip-leg.dto';
import { UpdateTripEventDto } from './dto/update-trip-event.dto';
import { UpdateTripStayDto } from './dto/update-trip-stay.dto';
import { UpdateTripContactDto } from './dto/update-trip-contact.dto';

function toDateOrUndefined(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(value);
}

// Приоритет 2 ТЗ — ручные правки отдельно от предложений
// (trip-changes.service.ts): правит напрямую тот, у кого право 'edit'
// (ORGANIZER/EDITOR), без цикла согласования — "подтверждённая ручная
// правка не перезатирается следующим проходом обработки" выполняется тем,
// что следующий агентный прогон пишет исключения в ProposedChange, никогда
// не трогая существующие записи напрямую (см. trip-run-execution.service.ts
// processUpdateToExistingTrip). Каждая ручная правка тоже попадает в
// TripRevision — история не делает разницы между "агент предложил, человек
// подтвердил" и "человек поправил сам", обе формы видимы на одной ленте.
@Injectable()
export class TripEditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rights: TripRightsService,
  ) {}

  async updateTrip(user: AuthenticatedUser, tripId: string, dto: UpdateTripDto) {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    const updated = await this.prisma.trip.update({
      where: { id: tripId },
      data: { title: dto.title, purposeSummary: dto.purposeSummary, cancelledAt: toDateOrUndefined(dto.cancelledAt) },
    });
    await this.recordRevision(user.id, tripId, 'TRIP', null, dto.cancelledAt !== undefined ? (dto.cancelledAt ? 'Поездка отменена' : 'Отмена поездки снята') : 'Поездка отредактирована вручную');
    return updated;
  }

  async updateLeg(user: AuthenticatedUser, tripId: string, legId: string, dto: UpdateTripLegDto) {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    await this.assertBelongsToTrip('tripLeg', legId, tripId);
    const updated = await this.prisma.tripLeg.update({
      where: { id: legId },
      data: { ...dto, departAt: toDateOrUndefined(dto.departAt), arriveAt: toDateOrUndefined(dto.arriveAt) },
    });
    await this.recordRevision(user.id, tripId, 'TRIP_LEG', legId, 'Перелёт/переезд отредактирован вручную');
    return updated;
  }

  async deleteLeg(user: AuthenticatedUser, tripId: string, legId: string): Promise<void> {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    await this.assertBelongsToTrip('tripLeg', legId, tripId);
    await this.prisma.tripLeg.delete({ where: { id: legId } });
    await this.recordRevision(user.id, tripId, 'TRIP_LEG', legId, 'Перелёт/переезд удалён вручную');
  }

  async updateEvent(user: AuthenticatedUser, tripId: string, eventId: string, dto: UpdateTripEventDto) {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    await this.assertBelongsToTrip('tripEvent', eventId, tripId);
    const updated = await this.prisma.tripEvent.update({
      where: { id: eventId },
      data: { ...dto, startAt: toDateOrUndefined(dto.startAt), dateOnly: toDateOrUndefined(dto.dateOnly), endAt: toDateOrUndefined(dto.endAt) },
    });
    await this.recordRevision(user.id, tripId, 'TRIP_EVENT', eventId, 'Событие программы отредактировано вручную');
    return updated;
  }

  async deleteEvent(user: AuthenticatedUser, tripId: string, eventId: string): Promise<void> {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    await this.assertBelongsToTrip('tripEvent', eventId, tripId);
    await this.prisma.tripEvent.delete({ where: { id: eventId } });
    await this.recordRevision(user.id, tripId, 'TRIP_EVENT', eventId, 'Событие программы удалено вручную');
  }

  async updateStay(user: AuthenticatedUser, tripId: string, stayId: string, dto: UpdateTripStayDto) {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    await this.assertBelongsToTrip('tripStay', stayId, tripId);
    const updated = await this.prisma.tripStay.update({
      where: { id: stayId },
      data: { ...dto, checkInAt: toDateOrUndefined(dto.checkInAt), checkOutAt: toDateOrUndefined(dto.checkOutAt) },
    });
    await this.recordRevision(user.id, tripId, 'TRIP_STAY', stayId, 'Проживание отредактировано вручную');
    return updated;
  }

  async deleteStay(user: AuthenticatedUser, tripId: string, stayId: string): Promise<void> {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    await this.assertBelongsToTrip('tripStay', stayId, tripId);
    await this.prisma.tripStay.delete({ where: { id: stayId } });
    await this.recordRevision(user.id, tripId, 'TRIP_STAY', stayId, 'Проживание удалено вручную');
  }

  async updateContact(user: AuthenticatedUser, tripId: string, contactId: string, dto: UpdateTripContactDto) {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    await this.assertBelongsToTrip('tripContact', contactId, tripId);
    const updated = await this.prisma.tripContact.update({ where: { id: contactId }, data: dto });
    await this.recordRevision(user.id, tripId, 'TRIP_CONTACT', contactId, 'Контакт отредактирован вручную');
    return updated;
  }

  async deleteContact(user: AuthenticatedUser, tripId: string, contactId: string): Promise<void> {
    await this.rights.assertPermission(tripId, user.id, 'edit');
    await this.assertBelongsToTrip('tripContact', contactId, tripId);
    await this.prisma.tripContact.delete({ where: { id: contactId } });
    await this.recordRevision(user.id, tripId, 'TRIP_CONTACT', contactId, 'Контакт удалён вручную');
  }

  // 404, не 403 — тот же принцип, что везде в модуле: чужая/несвязанная
  // запись не подтверждает даже свой собственный факт существования другой
  // поездке. Явный switch, не общая индексация по this.prisma[model] —
  // сгенерированные Prisma-делегаты у разных моделей несовместимы между
  // собой достаточно, чтобы единая сигнатура не типизировалась без `any`.
  private async assertBelongsToTrip(model: 'tripLeg' | 'tripEvent' | 'tripStay' | 'tripContact', id: string, tripId: string): Promise<void> {
    let row: { tripId: string } | null;
    switch (model) {
      case 'tripLeg':
        row = await this.prisma.tripLeg.findUnique({ where: { id } });
        break;
      case 'tripEvent':
        row = await this.prisma.tripEvent.findUnique({ where: { id } });
        break;
      case 'tripStay':
        row = await this.prisma.tripStay.findUnique({ where: { id } });
        break;
      case 'tripContact':
        row = await this.prisma.tripContact.findUnique({ where: { id } });
        break;
    }
    if (!row || row.tripId !== tripId) throw new NotFoundException('Запись не найдена');
  }

  private async recordRevision(actorId: string, tripId: string, entityType: 'TRIP' | 'TRIP_LEG' | 'TRIP_EVENT' | 'TRIP_STAY' | 'TRIP_CONTACT', entityId: string | null, summary: string): Promise<void> {
    await this.prisma.tripRevision.create({ data: { tripId, entityType, entityId, summary, appliedByEmployeeId: actorId } });
  }
}

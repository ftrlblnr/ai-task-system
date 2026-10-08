import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ProposedChange } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { TripRightsService } from './trip-rights.service';
import { parseDateOrNull } from './trip-compose';

interface TripFieldPeriodValue {
  periodStart: string | null;
  periodEnd: string | null;
  periodPrecision: 'UNKNOWN' | 'APPROXIMATE' | 'EXACT';
}

// Приоритет 2 ТЗ, раздел 7 — применение/отклонение предложений, созданных
// trip-run-execution.service.ts при обновлении существующей поездки.
// "Применить можно по одному или все сразу" — approve/reject по одному +
// approveAll. Каждое применённое предложение оставляет запись в
// TripRevision (вкладка "История") — именно здесь, не в момент создания
// предложения, раздел 6 ТЗ: история — это то, что РЕАЛЬНО изменилось, не
// то, что было предложено.
@Injectable()
export class TripChangesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rights: TripRightsService,
  ) {}

  async listChanges(user: AuthenticatedUser, tripId: string) {
    await this.rights.assertPermission(tripId, user.id, 'view');
    return this.prisma.proposedChange.findMany({ where: { tripId }, orderBy: { createdAt: 'desc' } });
  }

  async listRevisions(user: AuthenticatedUser, tripId: string) {
    await this.rights.assertPermission(tripId, user.id, 'view');
    return this.prisma.tripRevision.findMany({ where: { tripId }, orderBy: { appliedAt: 'desc' } });
  }

  async approve(user: AuthenticatedUser, tripId: string, changeId: string): Promise<void> {
    await this.rights.assertPermission(tripId, user.id, 'approve');
    const change = await this.getPendingOrThrow(tripId, changeId);
    await this.applyChange(user.id, change);
  }

  async reject(user: AuthenticatedUser, tripId: string, changeId: string): Promise<void> {
    await this.rights.assertPermission(tripId, user.id, 'approve');
    const change = await this.getPendingOrThrow(tripId, changeId);
    await this.prisma.proposedChange.update({
      where: { id: change.id },
      data: { status: 'REJECTED', resolvedAt: new Date(), resolvedByEmployeeId: user.id },
    });
  }

  async approveAll(user: AuthenticatedUser, tripId: string): Promise<{ approved: number }> {
    await this.rights.assertPermission(tripId, user.id, 'approve');
    const pending = await this.prisma.proposedChange.findMany({ where: { tripId, status: 'PENDING' } });
    for (const change of pending) await this.applyChange(user.id, change);
    return { approved: pending.length };
  }

  private async getPendingOrThrow(tripId: string, changeId: string): Promise<ProposedChange> {
    const change = await this.prisma.proposedChange.findUnique({ where: { id: changeId } });
    if (!change || change.tripId !== tripId) throw new NotFoundException('Предложение не найдено');
    if (change.status !== 'PENDING') throw new ConflictException('CHANGE_ALREADY_RESOLVED: предложение уже обработано');
    return change;
  }

  private async applyChange(actorId: string, change: ProposedChange): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const summary = change.entityType === 'TRIP' ? await this.applyTripFieldChange(tx, change) : await this.applyNewEntity(tx, change);

      await tx.proposedChange.update({ where: { id: change.id }, data: { status: 'APPLIED', resolvedAt: new Date(), resolvedByEmployeeId: actorId } });
      await tx.tripRevision.create({
        data: { tripId: change.tripId, changeId: change.id, entityType: change.entityType, entityId: change.entityId, summary, appliedByEmployeeId: actorId },
      });
    });
  }

  private async applyTripFieldChange(tx: Prisma.TransactionClient, change: ProposedChange): Promise<string> {
    if (change.fieldKey === 'period') {
      const value = change.proposedValue as unknown as TripFieldPeriodValue;
      await tx.trip.update({
        where: { id: change.tripId },
        data: { periodStart: parseDateOrNull(value.periodStart), periodEnd: parseDateOrNull(value.periodEnd), periodPrecision: value.periodPrecision },
      });
      return 'Обновлён период поездки';
    }
    if (change.fieldKey === 'purposeSummary') {
      await tx.trip.update({ where: { id: change.tripId }, data: { purposeSummary: change.proposedValue as unknown as string } });
      return 'Заполнено описание цели поездки';
    }
    throw new Error(`ProposedChange с неизвестным fieldKey=${change.fieldKey}`);
  }

  private async applyNewEntity(tx: Prisma.TransactionClient, change: ProposedChange): Promise<string> {
    const v = change.proposedValue as Record<string, unknown>;
    switch (change.entityType) {
      case 'TRIP_LEG':
        await tx.tripLeg.create({
          data: {
            tripId: change.tripId,
            mode: v.mode as never,
            fromLocation: v.fromLocation as string | null,
            toLocation: v.toLocation as string | null,
            departAt: parseDateOrNull(v.departAt as string | null),
            departTimeZoneOffsetMinutes: v.departTimeZoneOffsetMinutes as number | null,
            arriveAt: parseDateOrNull(v.arriveAt as string | null),
            arriveTimeZoneOffsetMinutes: v.arriveTimeZoneOffsetMinutes as number | null,
            carrier: v.carrier as string | null,
            referenceCode: v.referenceCode as string | null,
            bookingStatus: v.bookingStatus as never,
            sourceMaterialId: v.sourceMaterialId as string | null,
          },
        });
        return `Добавлен перелёт/переезд ${(v.fromLocation as string) ?? '?'} → ${(v.toLocation as string) ?? '?'}`;
      case 'TRIP_EVENT':
        await tx.tripEvent.create({
          data: {
            tripId: change.tripId,
            title: v.title as string,
            startAt: parseDateOrNull(v.startAt as string | null),
            startTimeZoneOffsetMinutes: v.startTimeZoneOffsetMinutes as number | null,
            dateOnly: parseDateOrNull(v.dateOnly as string | null),
            endAt: parseDateOrNull(v.endAt as string | null),
            location: v.location as string | null,
            notes: v.notes as string | null,
            sourceMaterialId: v.sourceMaterialId as string | null,
          },
        });
        return `Добавлено событие программы «${v.title as string}»`;
      case 'TRIP_STAY':
        await tx.tripStay.create({
          data: {
            tripId: change.tripId,
            name: v.name as string | null,
            address: v.address as string | null,
            checkInAt: parseDateOrNull(v.checkInAt as string | null),
            checkOutAt: parseDateOrNull(v.checkOutAt as string | null),
            bookingStatus: v.bookingStatus as never,
            sourceMaterialId: v.sourceMaterialId as string | null,
          },
        });
        return `Добавлено проживание${v.name ? ` «${v.name as string}»` : ''}`;
      case 'TRIP_CONTACT':
        await tx.tripContact.create({
          data: {
            tripId: change.tripId,
            name: v.name as string,
            role: v.role as never,
            organization: v.organization as string | null,
            email: v.email as string | null,
            phone: v.phone as string | null,
            sourceMaterialId: v.sourceMaterialId as string | null,
          },
        });
        return `Добавлен контакт ${v.name as string}`;
      default:
        throw new Error(`ProposedChange с неизвестным entityType=${change.entityType}`);
    }
  }
}

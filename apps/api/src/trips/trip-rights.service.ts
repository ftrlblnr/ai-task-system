import { Injectable, NotFoundException } from '@nestjs/common';
import { Role, TripAccessRole } from '@prisma/client';
import { isManager } from '../auth/roles';
import { PrismaService } from '../prisma/prisma.service';

// Агент поездок (ТЗ 08.10.2026, раздел 9) — права на конкретную поездку
// идут через TripMember. Ролевая модель 20.10.2026: руководитель и
// администратор видят и ведут ВСЕ поездки (как ORGANIZER, даже без
// членства); пользователь — только свои и те, куда его добавил создатель.
export type TripPermission = 'view' | 'materials.add' | 'edit' | 'approve' | 'manage_access' | 'archive';

export interface TripActor {
  id: string;
  role: Role;
}

const ROLE_PERMISSIONS: Record<TripAccessRole, ReadonlySet<TripPermission>> = {
  ORGANIZER: new Set<TripPermission>(['view', 'materials.add', 'edit', 'approve', 'manage_access', 'archive']),
  EDITOR: new Set<TripPermission>(['view', 'materials.add', 'edit']),
  APPROVER: new Set<TripPermission>(['view', 'approve']),
  VIEWER: new Set<TripPermission>(['view']),
};

@Injectable()
export class TripRightsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMembership(tripId: string, employeeId: string) {
    return this.prisma.tripMember.findUnique({ where: { tripId_employeeId: { tripId, employeeId } } });
  }

  // 404, не 403 — тот же принцип, что FilesService.assertOwnedFile и
  // calendar EventsService.findOne: отсутствие прав на конкретную поездку
  // не должно подтверждать клиенту даже факт её существования.
  async assertPermission(tripId: string, user: TripActor, permission: TripPermission): Promise<TripAccessRole> {
    if (isManager(user.role)) {
      const trip = await this.prisma.trip.findUnique({ where: { id: tripId }, select: { id: true } });
      if (!trip) throw new NotFoundException('Поездка не найдена');
      return 'ORGANIZER';
    }
    const member = await this.getMembership(tripId, user.id);
    if (!member || !ROLE_PERMISSIONS[member.accessRole].has(permission)) {
      throw new NotFoundException('Поездка не найдена');
    }
    return member.accessRole;
  }
}

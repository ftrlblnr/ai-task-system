import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TripAccessRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Агент поездок (ТЗ 08.10.2026, раздел 9) — права отдельные от Role enum:
// "организатор не получает доступ ко всем поездкам", "участие во встрече
// не даёт доступ к чужим паспортам/билетам/внутренним заметкам". Поэтому
// OWNER-роль сотрудника здесь НЕ проверяется и не даёт обхода — единственный
// источник правды про доступ к конкретной поездке — TripMember.
export type TripPermission = 'view' | 'materials.add' | 'edit' | 'approve' | 'manage_access' | 'archive';

const ROLE_PERMISSIONS: Record<TripAccessRole, ReadonlySet<TripPermission>> = {
  ORGANIZER: new Set<TripPermission>(['view', 'materials.add', 'edit', 'approve', 'manage_access', 'archive']),
  EDITOR: new Set<TripPermission>(['view', 'materials.add', 'edit']),
  APPROVER: new Set<TripPermission>(['view', 'approve']),
  VIEWER: new Set<TripPermission>(['view']),
};

@Injectable()
export class TripRightsService {
  constructor(private readonly prisma: PrismaService) {}

  // trips.create — "создать поездку для разрешённых руководителей", не
  // привязано к конкретной поездке, поэтому 403 (не 404) уместен: нет
  // ресурса, факт существования которого можно бы было скрывать.
  async assertCanCreateTrips(employeeId: string): Promise<void> {
    const employee = await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { canCreateTrips: true } });
    if (!employee?.canCreateTrips) {
      throw new ForbiddenException('TRIPS_CREATE_NOT_ALLOWED: нет права создавать поездки');
    }
  }

  async getMembership(tripId: string, employeeId: string) {
    return this.prisma.tripMember.findUnique({ where: { tripId_employeeId: { tripId, employeeId } } });
  }

  // 404, не 403 — тот же принцип, что FilesService.assertOwnedFile и
  // calendar EventsService.findOne: отсутствие прав на конкретную поездку
  // не должно подтверждать клиенту даже факт её существования.
  async assertPermission(tripId: string, employeeId: string, permission: TripPermission): Promise<TripAccessRole> {
    const member = await this.getMembership(tripId, employeeId);
    if (!member || !ROLE_PERMISSIONS[member.accessRole].has(permission)) {
      throw new NotFoundException('Поездка не найдена');
    }
    return member.accessRole;
  }
}

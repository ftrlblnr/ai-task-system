import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { TripRightsService } from './trip-rights.service';
import { AddTripMemberDto } from './dto/add-trip-member.dto';

// Раздел 9 ТЗ — trips.manage_access: "организатор не получает доступ ко
// всем поездкам" работает ровно потому, что это право проверяется per-
// поездка (TripRightsService.assertPermission), не глобально. Создатель и
// путешествующий руководитель могут быть разными людьми — именно этот
// сервис добавляет второго как участника, если он сам не создавал поездку.
@Injectable()
export class TripMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rights: TripRightsService,
  ) {}

  async listMembers(user: AuthenticatedUser, tripId: string) {
    await this.rights.assertPermission(tripId, user.id, 'view');
    return this.prisma.tripMember.findMany({ where: { tripId }, orderBy: { createdAt: 'asc' } });
  }

  async addOrUpdateMember(user: AuthenticatedUser, tripId: string, dto: AddTripMemberDto) {
    await this.rights.assertPermission(tripId, user.id, 'manage_access');
    return this.prisma.tripMember.upsert({
      where: { tripId_employeeId: { tripId, employeeId: dto.employeeId } },
      create: { tripId, employeeId: dto.employeeId, accessRole: dto.accessRole },
      update: { accessRole: dto.accessRole },
    });
  }

  // Не даём остаться поездке без единого ORGANIZER — иначе никто больше не
  // сможет управлять доступом (manage_access есть только у ORGANIZER).
  async removeMember(user: AuthenticatedUser, tripId: string, employeeId: string): Promise<void> {
    await this.rights.assertPermission(tripId, user.id, 'manage_access');
    const member = await this.prisma.tripMember.findUnique({ where: { tripId_employeeId: { tripId, employeeId } } });
    if (!member) throw new NotFoundException('Участник не найден');
    if (member.accessRole === 'ORGANIZER') {
      const organizerCount = await this.prisma.tripMember.count({ where: { tripId, accessRole: 'ORGANIZER' } });
      if (organizerCount <= 1) {
        throw new BadRequestException('CANNOT_REMOVE_LAST_ORGANIZER: у поездки должен остаться хотя бы один организатор');
      }
    }
    await this.prisma.tripMember.delete({ where: { id: member.id } });
  }
}

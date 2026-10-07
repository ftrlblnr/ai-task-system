import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { defaultAvailabilityPolicy, type AvailabilityPolicy, type WorkingHoursRule } from './calendar-availability';
import { UpdateCalendarPolicyDto } from './dto/update-calendar-policy.dto';

export interface CalendarPolicyView extends AvailabilityPolicy {
  // null — политика ещё не сохранялась, отданы встроенные значения по
  // умолчанию (раздел 11 ТЗ); PATCH тогда создаёт первую запись без
  // expectedVersion.
  version: number | null;
}

@Injectable()
export class CalendarPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrDefault(ownerId: string): Promise<CalendarPolicyView> {
    const row = await this.prisma.calendarPolicy.findUnique({ where: { ownerId } });
    if (!row) return { ...defaultAvailabilityPolicy(), version: null };
    return {
      version: row.version,
      timeZoneOffsetMinutes: row.timeZoneOffsetMinutes,
      workingHours: row.workingHours as unknown as WorkingHoursRule[],
      bufferMinutes: row.bufferMinutes,
      minNoticeHours: row.minNoticeHours,
      slotStepMinutes: row.slotStepMinutes,
    };
  }

  async update(ownerId: string, dto: UpdateCalendarPolicyDto): Promise<CalendarPolicyView> {
    const existing = await this.prisma.calendarPolicy.findUnique({ where: { ownerId } });
    const defaults = defaultAvailabilityPolicy();

    if (!existing) {
      const created = await this.prisma.calendarPolicy.create({
        data: {
          ownerId,
          timeZoneOffsetMinutes: dto.timeZoneOffsetMinutes ?? defaults.timeZoneOffsetMinutes,
          workingHours: (dto.workingHours ?? defaults.workingHours) as unknown as Prisma.InputJsonValue,
          bufferMinutes: dto.bufferMinutes ?? defaults.bufferMinutes,
          minNoticeHours: dto.minNoticeHours ?? defaults.minNoticeHours,
          slotStepMinutes: dto.slotStepMinutes ?? defaults.slotStepMinutes,
        },
      });
      return this.getOrDefault(created.ownerId);
    }

    if (dto.version !== undefined && dto.version !== existing.version) {
      throw new ConflictException('CALENDAR_POLICY_VERSION_CONFLICT: политика изменилась, перечитайте её перед правкой');
    }

    await this.prisma.calendarPolicy.update({
      where: { ownerId },
      data: {
        timeZoneOffsetMinutes: dto.timeZoneOffsetMinutes,
        workingHours: dto.workingHours as unknown as Prisma.InputJsonValue | undefined,
        bufferMinutes: dto.bufferMinutes,
        minNoticeHours: dto.minNoticeHours,
        slotStepMinutes: dto.slotStepMinutes,
        version: { increment: 1 },
      },
    });
    return this.getOrDefault(ownerId);
  }
}

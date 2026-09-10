import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Аудит-лог обращений к протоколам и задачам, отдельно от содержимого
// самих встреч (раздел 15 ТЗ). Пишем best-effort — сбой аудита не должен
// ломать основной запрос.
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    actorId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: { actorId, action, entityType, entityId, metadata },
      });
    } catch {
      // намеренно проглатываем — аудит не блокирует бизнес-операцию
    }
  }
}

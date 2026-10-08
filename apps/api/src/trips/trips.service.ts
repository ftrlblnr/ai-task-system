import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { FileArtifact } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { FilesService } from '../files/files.service';
import { TripRightsService } from './trip-rights.service';
import { computeTripTimeStatus } from './trip-status';

export interface MaterialUpload {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
}

// Раздел 18 ТЗ — "идемпотентность по пакету и содержимому файлов": хэш не
// зависит от порядка файлов в запросе (повторная отправка того же пакета в
// другом порядке — тот же пакет, не новый). Отдельно от общего
// IdempotencyService (см. trips.controller.ts — там Idempotency-Key
// защищает от повторного HTTP-запроса/дабл-тапа, а не от повторной
// отправки тех же файлов НОВЫМ запросом).
export function computeBatchContentHash(files: MaterialUpload[]): string {
  const perFileHashes = files
    .map((f) => createHash('sha256').update(f.buffer).update(f.originalName).digest('hex'))
    .sort();
  return createHash('sha256').update(perFileHashes.join('|')).digest('hex');
}

export const MAX_MATERIALS_PER_RUN = 10;

@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly rights: TripRightsService,
  ) {}

  // Раздел 3 ТЗ — главное действие "Собрать из материалов": создание не
  // требует полноты материалов, сразу заводит AgentRun (RECEIVED), который
  // доводит trip-run-execution.service.ts. Повтор с тем же набором файлов
  // (даже в другом порядке) не создаёт вторую карточку — см.
  // computeBatchContentHash.
  async createRun(user: AuthenticatedUser, materials: MaterialUpload[]) {
    await this.rights.assertCanCreateTrips(user.id);
    if (materials.length === 0) {
      throw new BadRequestException('Нужен хотя бы один материал');
    }
    if (materials.length > MAX_MATERIALS_PER_RUN) {
      throw new BadRequestException(`Не более ${MAX_MATERIALS_PER_RUN} материалов за один пакет`);
    }

    const idempotencyKey = computeBatchContentHash(materials);
    const existing = await this.prisma.agentRun.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;

    const artifacts: FileArtifact[] = [];
    for (const m of materials) {
      artifacts.push(await this.files.upload(user, m.buffer, m.originalName, m.mimeType));
    }

    try {
      return await this.prisma.agentRun.create({
        data: {
          initiatorId: user.id,
          idempotencyKey,
          status: 'RECEIVED',
          materials: {
            create: artifacts.map((a) => ({ fileArtifactId: a.id, addedByEmployeeId: user.id, processingStatus: 'PENDING' })),
          },
        },
        include: { materials: true },
      });
    } catch {
      // Гонка: второй параллельный запрос с тем же пакетом успел создать
      // AgentRun первым между проверкой выше и этим create() — отдаём уже
      // созданный, не плодим дубликат (unique-constraint на idempotencyKey).
      const racedWinner = await this.prisma.agentRun.findUnique({ where: { idempotencyKey } });
      if (racedWinner) return racedWinner;
      throw new BadRequestException('Не удалось создать пакет материалов');
    }
  }

  async getRun(user: AuthenticatedUser, runId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId }, include: { materials: true } });
    if (!run || run.initiatorId !== user.id) throw new NotFoundException('Пакет материалов не найден');
    return run;
  }

  async listMyRuns(user: AuthenticatedUser) {
    return this.prisma.agentRun.findMany({ where: { initiatorId: user.id }, orderBy: { createdAt: 'desc' }, take: 20 });
  }

  async listTrips(user: AuthenticatedUser) {
    const memberships = await this.prisma.tripMember.findMany({ where: { employeeId: user.id }, select: { tripId: true } });
    const tripIds = memberships.map((m) => m.tripId);
    if (tripIds.length === 0) return [];
    const trips = await this.prisma.trip.findMany({ where: { id: { in: tripIds } }, orderBy: { createdAt: 'desc' } });
    return trips.map((trip) => ({ ...trip, timeStatus: computeTripTimeStatus(trip) }));
  }

  async getTrip(user: AuthenticatedUser, tripId: string) {
    await this.rights.assertPermission(tripId, user.id, 'view');
    const trip = await this.prisma.trip.findUniqueOrThrow({
      where: { id: tripId },
      include: {
        legs: { orderBy: { departAt: 'asc' } },
        events: { orderBy: [{ dateOnly: 'asc' }, { startAt: 'asc' }] },
        stays: { orderBy: { checkInAt: 'asc' } },
        contacts: true,
        materials: true,
        facts: true,
        members: true,
      },
    });
    return { ...trip, timeStatus: computeTripTimeStatus(trip) };
  }
}

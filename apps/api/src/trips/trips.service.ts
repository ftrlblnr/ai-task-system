import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type FileArtifact, type TripMaterial } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { FilesService } from '../files/files.service';
import { TripRightsService } from './trip-rights.service';
import { computeTripTimeStatus } from './trip-status';
import { CreateTripDto } from './dto/create-trip.dto';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

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
// отправки тех же файлов НОВЫМ запросом). scope — 'NEW' для создания новой
// поездки, конкретный tripId для добавления материалов к существующей:
// один и тот же набор байт, отправленный в ДВЕ разные поездки, не должен
// схлопнуться в один AgentRun.
export function computeBatchContentHash(files: MaterialUpload[], scope: string = 'NEW'): string {
  const perFileHashes = files
    .map((f) => createHash('sha256').update(f.buffer).update(f.originalName).digest('hex'))
    .sort();
  return createHash('sha256').update(scope).update(perFileHashes.join('|')).digest('hex');
}

const RUN_INCLUDE = { materials: true } as const;

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
    return this.createRunInternal(user, materials, null);
  }

  // Приоритет 2 ТЗ — "Добавить информацию всегда обновляет ВЫБРАННУЮ
  // поездку, никогда не создаёт тихо новую": AgentRun получает tripId с
  // самого начала, trip-run-execution.service.ts видит это и идёт по ветке
  // предложений (ProposedChange), а не прямой записи.
  async addMaterialsToTrip(user: AuthenticatedUser, tripId: string, materials: MaterialUpload[]) {
    await this.rights.assertPermission(tripId, user.id, 'materials.add');
    return this.createRunInternal(user, materials, tripId);
  }

  private async createRunInternal(user: AuthenticatedUser, materials: MaterialUpload[], targetTripId: string | null) {
    if (materials.length === 0) {
      throw new BadRequestException('Нужен хотя бы один материал');
    }
    if (materials.length > MAX_MATERIALS_PER_RUN) {
      throw new BadRequestException(`Не более ${MAX_MATERIALS_PER_RUN} материалов за один пакет`);
    }

    const idempotencyKey = computeBatchContentHash(materials, targetTripId ?? 'NEW');
    const existing = await this.prisma.agentRun.findUnique({ where: { idempotencyKey }, include: RUN_INCLUDE });
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
          tripId: targetTripId,
          materials: {
            create: artifacts.map((a) => ({ fileArtifactId: a.id, addedByEmployeeId: user.id, processingStatus: 'PENDING' })),
          },
        },
        include: RUN_INCLUDE,
      });
    } catch {
      // Гонка: второй параллельный запрос с тем же пакетом успел создать
      // AgentRun первым между проверкой выше и этим create() — отдаём уже
      // созданный, не плодим дубликат (unique-constraint на idempotencyKey).
      const racedWinner = await this.prisma.agentRun.findUnique({ where: { idempotencyKey }, include: RUN_INCLUDE });
      if (racedWinner) return racedWinner;
      throw new BadRequestException('Не удалось создать пакет материалов');
    }
  }

  async getRun(user: AuthenticatedUser, runId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId }, include: RUN_INCLUDE });
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

  // Полный CRUD — создание карточки напрямую, без материалов (частный
  // случай "создание не требует полноты материалов", раздел 3 ТЗ: здесь
  // материалов вообще нет). Та же retry-на-конфликт логика выделения
  // humanCode, что в trip-run-execution.service.ts.createTripFromComposed
  // (отдельная копия, не общий helper — два вызывающих места достаточно
  // разные по контексту транзакции, чтобы делить код не стоило).
  async createManual(user: AuthenticatedUser, dto: CreateTripDto) {
    await this.rights.assertCanCreateTrips(user.id);
    const year = new Date().getFullYear();

    for (let attempt = 0; attempt < 5; attempt++) {
      const existingCount = await this.prisma.trip.count({ where: { humanCode: { startsWith: `TR-${year}-` } } });
      const humanCode = `TR-${year}-${String(existingCount + 1 + attempt).padStart(3, '0')}`;
      try {
        return await this.prisma.$transaction(async (tx) => {
          const trip = await tx.trip.create({
            data: {
              humanCode,
              title: dto.title,
              purposeSummary: dto.purposeSummary,
              organizerId: user.id,
              periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
              periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
              periodPrecision: dto.periodPrecision ?? (dto.periodStart ? 'EXACT' : 'UNKNOWN'),
            },
          });
          await tx.tripMember.create({ data: { tripId: trip.id, employeeId: user.id, accessRole: 'ORGANIZER' } });
          await tx.tripRevision.create({ data: { tripId: trip.id, entityType: 'TRIP', summary: 'Поездка создана вручную', appliedByEmployeeId: user.id } });
          return trip;
        });
      } catch (err) {
        if (isUniqueConstraintError(err) && attempt < 4) continue;
        throw err;
      }
    }
    throw new BadRequestException('Не удалось выделить код поездки после нескольких попыток');
  }

  // Полный CRUD — trips.archive (раздел 9 ТЗ), только ORGANIZER. Жёсткое
  // удаление, не "отмена" (та — PATCH cancelledAt, отдельное действие):
  // каскадно удаляет legs/events/stays/contacts/materials/facts/members/
  // ProposedChange/TripRevision этой поездки (onDelete: Cascade в схеме),
  // AgentRun этой поездки остаётся (tripId становится null, см.
  // onDelete: SetNull) — сам пакет обработки не часть поездки как сущности.
  async deleteTrip(user: AuthenticatedUser, tripId: string): Promise<void> {
    await this.rights.assertPermission(tripId, user.id, 'archive');
    await this.prisma.trip.delete({ where: { id: tripId } });
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
    const materials = await this.enrichMaterials(trip.materials);
    return { ...trip, materials, timeStatus: computeTripTimeStatus(trip) };
  }

  // Живой баг 08.10.2026 — TripMaterial.fileArtifactId простая строка, не
  // формальная Prisma-связь (как EmailAttachment), поэтому include
  // никогда не подтягивает имя/тип файла сам — раньше это заканчивалось
  // тем, что веб показывал сырой fileArtifactId вместо имени документа.
  // FileArtifact может уже не существовать (материал загружен раньше
  // фикса orphan-чистки в files-cleanup.cron.ts) — тогда просто
  // downloadable:false, не ошибка на всю карточку поездки.
  private async enrichMaterials(materials: TripMaterial[]) {
    if (materials.length === 0) return [];
    const files = await this.prisma.fileArtifact.findMany({
      where: { id: { in: materials.map((m) => m.fileArtifactId) } },
      select: { id: true, name: true, mimeType: true, size: true },
    });
    const byId = new Map(files.map((f) => [f.id, f]));
    return materials.map((m) => {
      const file = byId.get(m.fileArtifactId);
      return { ...m, fileName: file?.name ?? null, mimeType: file?.mimeType ?? null, size: file?.size ?? null, downloadable: !!file };
    });
  }

  // Доступ — та же 'view' permission, что getTrip: любой участник
  // поездки может скачать её материал, не только тот, кто его загрузил
  // (см. FilesService.getStreamForProcessing — личное владение файлом
  // здесь намеренно не проверяется).
  async downloadMaterial(user: AuthenticatedUser, tripId: string, materialId: string) {
    await this.rights.assertPermission(tripId, user.id, 'view');
    const material = await this.prisma.tripMaterial.findUnique({ where: { id: materialId } });
    if (!material || material.tripId !== tripId) throw new NotFoundException('Материал не найден');
    return this.files.getStreamForProcessing(material.fileArtifactId);
  }
}

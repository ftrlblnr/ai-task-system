import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReceptionEventType, ReceptionRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CreateReceptionRequestDto } from './dto/create-reception-request.dto';
import { EditReceptionRequestDto } from './dto/edit-reception-request.dto';
import { RejectReceptionRequestDto } from './dto/reject.dto';
import { CompleteReceptionRequestDto } from './dto/complete.dto';

// Единственная запись очереди в MVP (раздел 11.1 ТЗ) — фиксированный id,
// upsert по PK вместо отдельного bootstrap-шага/сида; гонки на создании нет
// (upsert по первичному ключу атомарен на уровне Postgres).
const QUEUE_ID = 'default';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// null/''-после-trim — отсутствующее значение (раздел 5 ТЗ): "причина
// отказа из одних пробелов сохраняется как null", тот же принцип для всех
// необязательных текстовых полей.
function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// queueOrder/nextOrder — BigInt, JSON.stringify молча падает на BigInt;
// раздел 11.2 ТЗ прямо требует отдавать клиенту строкой, не числом (риск
// потери точности в JS).
function serializeRequest<T extends { queueOrder: bigint }>(row: T): Omit<T, 'queueOrder'> & { queueOrder: string } {
  return { ...row, queueOrder: row.queueOrder.toString() };
}

const DETAIL_SELECT = {
  id: true,
  authorId: true,
  author: { select: { id: true, fullName: true, status: true } },
  title: true,
  description: true,
  requestType: true,
  expectedMinutes: true,
  desiredBy: true,
  urgencyReason: true,
  status: true,
  queueOrder: true,
  version: true,
  lastCalledAt: true,
  closedAt: true,
  rejectionReason: true,
  resolution: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReceptionRequestSelect;

type RequestRow = Prisma.ReceptionRequestGetPayload<{ select: typeof DETAIL_SELECT }>;

interface TransitionResult {
  request: RequestRow;
}

// Общая форма перехода CALLED/REJECTED/COMPLETED/RETURNED_TO_QUEUE — раздел 6
// ТЗ (таблица переходов), каждый со своим ровно ОДНИМ допустимым исходным
// статусом. create/edit/withdraw/move-to-end построены отдельно ниже —
// отличаются достаточно (переназначение queueOrder, разный scope владения),
// чтобы не натягивать на один и тот же шаблон.
interface TransitionSpec {
  fromStatus: ReceptionRequestStatus;
  toStatus: ReceptionRequestStatus;
  eventType: ReceptionEventType;
  data?: Record<string, unknown>;
}

@Injectable()
export class ReceptionService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureQueue(tx: Prisma.TransactionClient): Promise<void> {
    await tx.receptionQueue.upsert({ where: { id: QUEUE_ID }, create: { id: QUEUE_ID }, update: {} });
  }

  // Атомарный инкремент общего счётчика очереди (раздел 7.1 ТЗ — НЕ
  // SELECT MAX(order)+1, гонка под конкурентной подачей). Один UPDATE...
  // RETURNING — Postgres сам сериализует конкурентные обновления ОДНОЙ
  // строки, отдельная блокировка не нужна.
  private async nextQueueOrder(tx: Prisma.TransactionClient): Promise<bigint> {
    await this.ensureQueue(tx);
    const rows = await tx.$queryRaw<{ assigned: bigint }[]>(
      Prisma.sql`UPDATE "ReceptionQueue" SET "nextOrder" = "nextOrder" + 1, "updatedAt" = now() WHERE "id" = ${QUEUE_ID} RETURNING ("nextOrder" - 1) AS "assigned"`,
    );
    return rows[0].assigned;
  }

  async create(author: AuthenticatedUser, dto: CreateReceptionRequestDto) {
    if (dto.desiredBy && new Date(dto.desiredBy).getTime() <= Date.now()) {
      throw new ConflictException('INVALID_DESIRED_BY: срок должен быть в будущем');
    }

    const request = await this.prisma.$transaction(async (tx) => {
      const queueOrder = await this.nextQueueOrder(tx);
      const created = await tx.receptionRequest.create({
        data: {
          queueId: QUEUE_ID,
          authorId: author.id,
          title: dto.title.trim(),
          description: dto.description.trim(),
          requestType: dto.requestType,
          expectedMinutes: dto.expectedMinutes ?? null,
          desiredBy: dto.desiredBy ? new Date(dto.desiredBy) : null,
          urgencyReason: normalizeOptionalText(dto.urgencyReason),
          queueOrder,
        },
        select: DETAIL_SELECT,
      });
      await tx.receptionEvent.create({
        data: { requestId: created.id, actorId: author.id, type: 'CREATED', toStatus: 'WAITING', requestVersion: created.version },
      });
      return created;
    });
    return serializeRequest(request);
  }

  // Автор редактирует СВОЁ ожидающее обращение (раздел 6 ТЗ: WAITING →
  // WAITING). 404 для чужого/несуществующего — не подтверждаем факт
  // существования (раздел 4 ТЗ).
  async edit(actor: AuthenticatedUser, id: string, dto: EditReceptionRequestDto) {
    if (dto.desiredBy && new Date(dto.desiredBy).getTime() <= Date.now()) {
      throw new ConflictException('INVALID_DESIRED_BY: срок должен быть в будущем');
    }

    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description.trim();
    if (dto.requestType !== undefined) data.requestType = dto.requestType;
    if (dto.expectedMinutes !== undefined) data.expectedMinutes = dto.expectedMinutes;
    if (dto.desiredBy !== undefined) data.desiredBy = dto.desiredBy ? new Date(dto.desiredBy) : null;
    if (dto.urgencyReason !== undefined) data.urgencyReason = normalizeOptionalText(dto.urgencyReason);

    const request = await this.prisma.$transaction(async (tx) => {
      const result = await tx.receptionRequest.updateMany({
        where: { id, authorId: actor.id, version: dto.version, status: 'WAITING' },
        data: { ...data, version: { increment: 1 } },
      });
      if (result.count === 0) throw await this.classifyTransitionFailure(tx, id, actor.id, dto.version, 'WAITING');

      const updated = await tx.receptionRequest.findUniqueOrThrow({ where: { id }, select: DETAIL_SELECT });
      await tx.receptionEvent.create({
        data: {
          requestId: id,
          actorId: actor.id,
          type: 'EDITED',
          fromStatus: 'WAITING',
          toStatus: 'WAITING',
          requestVersion: updated.version,
          metadata: data as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
    return serializeRequest(request);
  }

  async withdraw(actor: AuthenticatedUser, id: string, expectedVersion: number) {
    return this.runAuthorTransition(actor, id, expectedVersion, {
      fromStatus: 'WAITING',
      toStatus: 'WITHDRAWN',
      eventType: 'WITHDRAWN',
      data: { closedAt: new Date() },
    });
  }

  // Раздел 7 ТЗ, пункт 5: перенос УЖЕ последнего обращения — успешная
  // операция без изменения порядка и без лишней записи в журнале. Пункт 6:
  // "в конец" — конец ВСЕЙ очереди WAITING, не видимого подмножества
  // (поэтому MAX(queueOrder) считается без фильтров поиска/пагинации).
  async moveToEnd(owner: AuthenticatedUser, id: string, expectedVersion: number) {
    const request = await this.prisma.$transaction(async (tx) => {
      const current = await tx.receptionRequest.findUnique({ where: { id }, select: DETAIL_SELECT });
      if (!current) throw new NotFoundException('Обращение не найдено');
      if (current.status !== 'WAITING') {
        throw new ConflictException('INVALID_TRANSITION: обращение не ожидает очереди');
      }
      if (current.version !== expectedVersion) {
        throw new ConflictException('VERSION_CONFLICT: обращение уже изменилось. Список обновлён');
      }

      const { _max } = await tx.receptionRequest.aggregate({
        where: { queueId: QUEUE_ID, status: 'WAITING' },
        _max: { queueOrder: true },
      });
      if (_max.queueOrder !== null && _max.queueOrder === current.queueOrder) {
        return current; // уже последнее — без изменений, без события (раздел 7 ТЗ)
      }

      const queueOrder = await this.nextQueueOrder(tx);
      const result = await tx.receptionRequest.updateMany({
        where: { id, version: expectedVersion, status: 'WAITING' },
        data: { queueOrder, version: { increment: 1 } },
      });
      if (result.count === 0) throw await this.classifyTransitionFailure(tx, id, undefined, expectedVersion, 'WAITING');

      const updated = await tx.receptionRequest.findUniqueOrThrow({ where: { id }, select: DETAIL_SELECT });
      await tx.receptionEvent.create({
        data: { requestId: id, actorId: owner.id, type: 'MOVED_TO_END', fromStatus: 'WAITING', toStatus: 'WAITING', requestVersion: updated.version },
      });
      return updated;
    });
    return serializeRequest(request);
  }

  async call(owner: AuthenticatedUser, id: string, expectedVersion: number) {
    return this.runOwnerTransition(owner, id, expectedVersion, {
      fromStatus: 'WAITING',
      toStatus: 'CALLED',
      eventType: 'CALLED',
      data: { lastCalledAt: new Date() },
    }, { notifyKind: 'CALLED', uniqueViolationCode: 'RECEPTION_BUSY: уже вызван другой сотрудник — сначала завершите текущий приём' });
  }

  async reject(owner: AuthenticatedUser, id: string, dto: RejectReceptionRequestDto) {
    return this.runOwnerTransition(owner, id, dto.version, {
      fromStatus: 'WAITING',
      toStatus: 'REJECTED',
      eventType: 'REJECTED',
      data: { closedAt: new Date(), rejectionReason: normalizeOptionalText(dto.reason) },
    }, { notifyKind: 'REJECTED' });
  }

  async complete(owner: AuthenticatedUser, id: string, dto: CompleteReceptionRequestDto) {
    return this.runOwnerTransition(owner, id, dto.version, {
      fromStatus: 'CALLED',
      toStatus: 'COMPLETED',
      eventType: 'COMPLETED',
      data: { closedAt: new Date(), resolution: normalizeOptionalText(dto.resolution) },
    }, { supersedeCalledNotification: true });
  }

  async returnToQueue(owner: AuthenticatedUser, id: string, expectedVersion: number) {
    return this.prisma.$transaction(async (tx) => {
      const queueOrder = await this.nextQueueOrder(tx);
      const result = await tx.receptionRequest.updateMany({
        where: { id, version: expectedVersion, status: 'CALLED' },
        data: { status: 'WAITING', queueOrder, version: { increment: 1 } },
      });
      if (result.count === 0) throw await this.classifyTransitionFailure(tx, id, undefined, expectedVersion, 'CALLED');

      const updated = await tx.receptionRequest.findUniqueOrThrow({ where: { id }, select: DETAIL_SELECT });
      const event = await tx.receptionEvent.create({
        data: { requestId: id, actorId: owner.id, type: 'RETURNED_TO_QUEUE', fromStatus: 'CALLED', toStatus: 'WAITING', requestVersion: updated.version },
      });
      // Раздел 10.2 ТЗ — ещё не отправленное уведомление о (теперь отменённом)
      // вызове переводится в SUPERSEDED, не отправляется задним числом.
      await tx.receptionNotification.updateMany({
        where: { requestId: id, kind: 'CALLED', status: 'PENDING' },
        data: { status: 'SUPERSEDED' },
      });
      await tx.receptionNotification.create({
        data: { eventId: event.id, requestId: id, recipientId: updated.authorId, kind: 'RETURNED_TO_QUEUE' },
      });
      return serializeRequest(updated);
    });
  }

  // --- общая инфраструктура переходов OWNER-действий (call/reject/complete) ---

  private async runOwnerTransition(
    owner: AuthenticatedUser,
    id: string,
    expectedVersion: number,
    spec: TransitionSpec,
    opts: { notifyKind?: 'CALLED' | 'REJECTED'; uniqueViolationCode?: string; supersedeCalledNotification?: boolean } = {},
  ) {
    const request = await this.prisma.$transaction(async (tx) => {
      let result: Prisma.BatchPayload;
      try {
        result = await tx.receptionRequest.updateMany({
          where: { id, version: expectedVersion, status: spec.fromStatus },
          data: { status: spec.toStatus, version: { increment: 1 }, ...spec.data },
        });
      } catch (err) {
        if (isUniqueConstraintError(err) && opts.uniqueViolationCode) {
          throw new ConflictException(opts.uniqueViolationCode);
        }
        throw err;
      }
      if (result.count === 0) throw await this.classifyTransitionFailure(tx, id, undefined, expectedVersion, spec.fromStatus);

      const updated = await tx.receptionRequest.findUniqueOrThrow({ where: { id }, select: DETAIL_SELECT });
      const event = await tx.receptionEvent.create({
        data: {
          requestId: id,
          actorId: owner.id,
          type: spec.eventType,
          fromStatus: spec.fromStatus,
          toStatus: spec.toStatus,
          requestVersion: updated.version,
        },
      });

      if (opts.supersedeCalledNotification) {
        await tx.receptionNotification.updateMany({
          where: { requestId: id, kind: 'CALLED', status: 'PENDING' },
          data: { status: 'SUPERSEDED' },
        });
      }
      if (opts.notifyKind) {
        await tx.receptionNotification.create({
          data: { eventId: event.id, requestId: id, recipientId: updated.authorId, kind: opts.notifyKind },
        });
      }
      return updated;
    });
    return serializeRequest(request);
  }

  private async runAuthorTransition(actor: AuthenticatedUser, id: string, expectedVersion: number, spec: TransitionSpec) {
    const request = await this.prisma.$transaction(async (tx) => {
      const result = await tx.receptionRequest.updateMany({
        where: { id, authorId: actor.id, version: expectedVersion, status: spec.fromStatus },
        data: { status: spec.toStatus, version: { increment: 1 }, ...spec.data },
      });
      if (result.count === 0) throw await this.classifyTransitionFailure(tx, id, actor.id, expectedVersion, spec.fromStatus);

      const updated = await tx.receptionRequest.findUniqueOrThrow({ where: { id }, select: DETAIL_SELECT });
      await tx.receptionEvent.create({
        data: { requestId: id, actorId: actor.id, type: spec.eventType, fromStatus: spec.fromStatus, toStatus: spec.toStatus, requestVersion: updated.version },
      });
      return updated;
    });
    return serializeRequest(request);
  }

  // Классифицирует ПОЧЕМУ guarded updateMany вернул 0 строк — только для
  // точного кода ошибки клиенту, саму корректность гарантирует WHERE
  // атомарного UPDATE выше, не этот повторный read (неизбежный små TOCTOU
  // между ними не влияет на корректность — на этот момент транзакция уже
  // знает, что реальное изменение не применилось).
  private async classifyTransitionFailure(
    tx: Prisma.TransactionClient,
    id: string,
    requireAuthorId: string | undefined,
    expectedVersion: number,
    expectedStatus: ReceptionRequestStatus,
  ): Promise<ConflictException | NotFoundException> {
    const current = await tx.receptionRequest.findUnique({ where: { id }, select: { authorId: true, status: true, version: true } });
    if (!current || (requireAuthorId && current.authorId !== requireAuthorId)) {
      return new NotFoundException('Обращение не найдено');
    }
    if (current.status !== expectedStatus) {
      return new ConflictException('INVALID_TRANSITION: обращение уже в другом статусе');
    }
    if (current.version !== expectedVersion) {
      return new ConflictException('VERSION_CONFLICT: обращение уже изменилось. Список обновлён');
    }
    return new ConflictException('VERSION_CONFLICT: обращение уже изменилось. Список обновлён');
  }

  // --- чтение ---

  async getOne(actor: AuthenticatedUser, id: string) {
    const request = await this.prisma.receptionRequest.findUnique({ where: { id }, select: DETAIL_SELECT });
    if (!request) throw new NotFoundException('Обращение не найдено');
    if (actor.role !== 'OWNER' && request.authorId !== actor.id) throw new NotFoundException('Обращение не найдено');
    return serializeRequest(request);
  }

  async getMine(actor: AuthenticatedUser, scope: 'active' | 'history', limit: number, offset: number) {
    const statuses: ReceptionRequestStatus[] = scope === 'active' ? ['WAITING', 'CALLED'] : ['COMPLETED', 'REJECTED', 'WITHDRAWN'];
    const where: Prisma.ReceptionRequestWhereInput = { authorId: actor.id, status: { in: statuses } };
    const orderBy: Prisma.ReceptionRequestOrderByWithRelationInput =
      scope === 'active' ? { queueOrder: 'asc' } : { closedAt: 'desc' };
    const [items, totalCount] = await Promise.all([
      this.prisma.receptionRequest.findMany({ where, select: DETAIL_SELECT, orderBy, take: limit, skip: offset }),
      this.prisma.receptionRequest.count({ where }),
    ]);
    return { items: items.map(serializeRequest), totalCount };
  }

  // Раздел 9.1 ТЗ — текущий вызов и totalWaiting возвращаются независимо от
  // фильтров/страницы очереди (owner должен видеть их всегда, даже при
  // активном поиске).
  async getQueueView(filters: { search?: string; authorId?: string; expiredOnly?: boolean }, limit: number, offset: number) {
    const where: Prisma.ReceptionRequestWhereInput = { queueId: QUEUE_ID, status: 'WAITING' };
    const and: Prisma.ReceptionRequestWhereInput[] = [];
    if (filters.authorId) where.authorId = filters.authorId;
    if (filters.expiredOnly) where.desiredBy = { lt: new Date() };
    if (filters.search) {
      const contains = { contains: filters.search, mode: 'insensitive' as const };
      and.push({ OR: [{ title: contains }, { author: { is: { fullName: contains } } }] });
    }
    if (and.length > 0) where.AND = and;

    const [current, items, totalCount, totalWaiting] = await Promise.all([
      this.prisma.receptionRequest.findFirst({ where: { queueId: QUEUE_ID, status: 'CALLED' }, select: DETAIL_SELECT }),
      this.prisma.receptionRequest.findMany({ where, select: DETAIL_SELECT, orderBy: [{ queueOrder: 'asc' }, { id: 'asc' }], take: limit, skip: offset }),
      this.prisma.receptionRequest.count({ where }),
      this.prisma.receptionRequest.count({ where: { queueId: QUEUE_ID, status: 'WAITING' } }),
    ]);
    // Раздел 9.1 ТЗ — "состояние уведомления" в блоке текущего вызова:
    // статус последней CALLED-доставки этого обращения, не джойн в общую
    // выборку (нужен только для ОДНОЙ записи — текущего вызова).
    let currentNotificationStatus: string | null = null;
    if (current) {
      const notification = await this.prisma.receptionNotification.findFirst({
        where: { requestId: current.id, kind: 'CALLED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true },
      });
      currentNotificationStatus = notification?.status ?? null;
    }
    return {
      current: current ? { ...serializeRequest(current), notificationStatus: currentNotificationStatus } : null,
      items: items.map(serializeRequest),
      totalCount,
      totalWaiting,
    };
  }

  async getHistory(
    filters: { authorId?: string; status?: ReceptionRequestStatus; closedFrom?: Date; closedTo?: Date },
    limit: number,
    offset: number,
  ) {
    const where: Prisma.ReceptionRequestWhereInput = {
      queueId: QUEUE_ID,
      status: { in: ['COMPLETED', 'REJECTED', 'WITHDRAWN'] },
    };
    if (filters.authorId) where.authorId = filters.authorId;
    if (filters.status) where.status = filters.status;
    if (filters.closedFrom || filters.closedTo) {
      where.closedAt = { ...(filters.closedFrom ? { gte: filters.closedFrom } : {}), ...(filters.closedTo ? { lte: filters.closedTo } : {}) };
    }
    const [items, totalCount] = await Promise.all([
      this.prisma.receptionRequest.findMany({ where, select: DETAIL_SELECT, orderBy: [{ closedAt: 'desc' }, { id: 'desc' }], take: limit, skip: offset }),
      this.prisma.receptionRequest.count({ where }),
    ]);
    return { items: items.map(serializeRequest), totalCount };
  }

  // Раздел 11.3 ТЗ: журнал доступен OWNER и автору в пределах своего
  // обращения, но технические поля доставки (ReceptionNotification) автору
  // не раскрываются. Эта выборка не джойнит ReceptionNotification вовсе —
  // статус уведомления OWNER видит отдельно, в блоке текущего вызова
  // (getQueueView), не здесь, так что одной и той же проекции достаточно
  // для обеих ролей.
  async getEvents(actor: AuthenticatedUser, requestId: string) {
    const request = await this.prisma.receptionRequest.findUnique({ where: { id: requestId }, select: { authorId: true } });
    if (!request) throw new NotFoundException('Обращение не найдено');
    if (actor.role !== 'OWNER' && request.authorId !== actor.id) throw new NotFoundException('Обращение не найдено');
    return this.prisma.receptionEvent.findMany({
      where: { requestId },
      select: { id: true, type: true, fromStatus: true, toStatus: true, createdAt: true, actor: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Раздел 10.2 ТЗ — ручной повтор ТОЛЬКО для уже исчерпавшего
  // автоматические попытки уведомления (FAILED); сбрасывает attemptCount —
  // ручной запрос владельца это новая попытка, не продолжение старой серии.
  async retryNotification(notificationId: string): Promise<void> {
    const result = await this.prisma.receptionNotification.updateMany({
      where: { id: notificationId, status: 'FAILED' },
      data: { status: 'PENDING', attemptCount: 0, nextAttemptAt: new Date(), lockedAt: null, lockedBy: null, lastErrorCode: null },
    });
    if (result.count === 0) {
      const existing = await this.prisma.receptionNotification.findUnique({ where: { id: notificationId }, select: { id: true } });
      if (!existing) throw new NotFoundException('Уведомление не найдено');
      throw new ConflictException('INVALID_TRANSITION: повторить можно только неуспешное уведомление');
    }
  }
}

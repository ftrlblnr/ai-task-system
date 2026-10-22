import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, ReceptionEventType, ReceptionRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isManager } from '../auth/roles';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CreateReceptionRequestDto } from './dto/create-reception-request.dto';
import { EditReceptionRequestDto } from './dto/edit-reception-request.dto';
import { RejectReceptionRequestDto } from './dto/reject.dto';
import { CompleteReceptionRequestDto } from './dto/complete.dto';
import { AnswerReceptionRequestDto, AnswerTaskDto, DelegateReceptionRequestDto } from './dto/answer.dto';
import { TelegramBotService } from '../telegram/telegram-bot.service';

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

// Закрытые статусы — история автора и вкладка «История» руководителя.
const CLOSED_STATUSES: ReceptionRequestStatus[] = ['COMPLETED', 'ANSWERED', 'DELEGATED', 'REJECTED', 'WITHDRAWN'];

// Доска руководителя показывает закрытые за последнюю неделю, остальное —
// во вкладке «История».
const BOARD_RECENT_DAYS = 7;
const BOARD_RECENT_LIMIT = 30;
const BOARD_WAITING_LIMIT = 100;
const MAX_ANSWER_TEMPLATES = 30;

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
  task: { select: { id: true, title: true, dueDate: true, assignee: { select: { id: true, fullName: true } } } },
  attachments: { select: { fileId: true, name: true, mimeType: true, size: true }, orderBy: { createdAt: 'asc' } },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ReceptionRequestSelect;

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

// Привязка файлов автора к обращению. Только свои файлы, ещё не
// отправленные в чат и не приложенные к другому обращению; уже приложенные
// к ЭТОМУ — остаются как есть. Убранные из списка отвязываются (файл станет
// «сиротой» и уйдёт по FilesCleanupCron). Возвращает имена для журнала.
async function syncAttachments(tx: Prisma.TransactionClient, requestId: string, authorId: string, fileIds: string[]): Promise<string[]> {
  const wanted = [...new Set(fileIds)];
  await tx.receptionAttachment.deleteMany({ where: { requestId, fileId: { notIn: wanted } } });
  if (wanted.length === 0) return [];
  const files = await tx.fileArtifact.findMany({
    where: { id: { in: wanted }, employeeId: authorId, messageId: null },
    select: { id: true, name: true, mimeType: true, size: true, receptionAttachment: { select: { requestId: true } } },
  });
  const usable = files.filter((f) => !f.receptionAttachment || f.receptionAttachment.requestId === requestId);
  if (usable.length !== wanted.length) throw new BadRequestException('FILE_NOT_FOUND: файл не найден — загрузите его заново');
  const fresh = usable.filter((f) => !f.receptionAttachment);
  if (fresh.length > 0) {
    await tx.receptionAttachment.createMany({
      data: fresh.map((f) => ({ requestId, fileId: f.id, name: f.name, mimeType: f.mimeType, size: f.size })),
    });
  }
  return wanted.map((id) => usable.find((f) => f.id === id)!.name);
}

@Injectable()
export class ReceptionService {
  constructor(
    private readonly prisma: PrismaService,
    // Только для «вам назначена задача», когда исполнитель — не автор
    // вопроса (автору всё уходит одним сообщением через outbox).
    @Optional() private readonly bot?: TelegramBotService,
  ) {}

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
      const { id } = await tx.receptionRequest.create({
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
        select: { id: true },
      });
      if (dto.fileIds?.length) await syncAttachments(tx, id, author.id, dto.fileIds);
      const created = await tx.receptionRequest.findUniqueOrThrow({ where: { id }, select: DETAIL_SELECT });
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
      if (dto.fileIds !== undefined) data.attachments = await syncAttachments(tx, id, actor.id, dto.fileIds);

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

  // Ручной порядок очереди (владелец 20.10.2026): вопрос встаёт перед
  // beforeId (без него — в конец). Номера очереди не выдаются заново —
  // тот же набор queueOrder раскладывается в новом порядке, меняются только
  // вопросы между старым и новым местом; version растёт только у
  // перемещённого (у остальных содержимое не менялось).
  async reorder(owner: AuthenticatedUser, id: string, expectedVersion: number, beforeId?: string) {
    if (beforeId === id) throw new BadRequestException('Нельзя поставить вопрос перед самим собой');
    const request = await this.prisma.$transaction(async (tx) => {
      // Перестановки и новые обращения (nextQueueOrder) идут по одной.
      await this.ensureQueue(tx);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ReceptionQueue" WHERE "id" = ${QUEUE_ID} FOR UPDATE`);

      const waiting = await tx.receptionRequest.findMany({
        where: { queueId: QUEUE_ID, status: 'WAITING' },
        select: { id: true, queueOrder: true },
        orderBy: [{ queueOrder: 'asc' }, { id: 'asc' }],
      });
      const fromIndex = waiting.findIndex((r) => r.id === id);
      if (fromIndex < 0) throw await this.classifyTransitionFailure(tx, id, undefined, expectedVersion, 'WAITING');
      const rest = waiting.filter((r) => r.id !== id);
      const toIndex = beforeId ? rest.findIndex((r) => r.id === beforeId) : rest.length;
      if (toIndex < 0) throw new ConflictException('VERSION_CONFLICT: очередь уже изменилась. Список обновлён');
      if (toIndex === fromIndex) {
        return tx.receptionRequest.findUniqueOrThrow({ where: { id }, select: DETAIL_SELECT }); // место не изменилось
      }

      const reordered = [...rest.slice(0, toIndex), waiting[fromIndex], ...rest.slice(toIndex)];
      const moved = await tx.receptionRequest.updateMany({
        where: { id, version: expectedVersion, status: 'WAITING' },
        data: { queueOrder: waiting[toIndex].queueOrder, version: { increment: 1 } },
      });
      if (moved.count === 0) throw await this.classifyTransitionFailure(tx, id, undefined, expectedVersion, 'WAITING');
      for (let i = 0; i < reordered.length; i++) {
        if (reordered[i].id === id || reordered[i].id === waiting[i].id) continue;
        await tx.receptionRequest.updateMany({ where: { id: reordered[i].id, status: 'WAITING' }, data: { queueOrder: waiting[i].queueOrder } });
      }

      const updated = await tx.receptionRequest.findUniqueOrThrow({ where: { id }, select: DETAIL_SELECT });
      await tx.receptionEvent.create({
        data: {
          requestId: id,
          actorId: owner.id,
          type: 'REORDERED',
          fromStatus: 'WAITING',
          toStatus: 'WAITING',
          requestVersion: updated.version,
          metadata: { fromPosition: fromIndex + 1, toPosition: toIndex + 1 },
        },
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

  // Владелец 20.10.2026 — ответить без встречи (текстом или надиктовав)
  // можно и ожидающему, и уже вызванному: вопрос уходит в «Отвечено»,
  // автор получает текст ответа в Telegram.
  async answer(owner: AuthenticatedUser, id: string, dto: AnswerReceptionRequestDto) {
    const text = normalizeOptionalText(dto.text);
    if (!text) throw new BadRequestException('Напишите или надиктуйте ответ');
    const result = await this.closeByOwner(owner, id, dto.version, 'ANSWERED', text, dto.task);
    const task = result.task;
    if (task?.assignee && task.assignee.id !== result.authorId && task.assignee.id !== owner.id) {
      const due = task.dueDate ? ` (срок: ${task.dueDate.toLocaleDateString('ru-RU')})` : '';
      void this.prisma.employee
        .findUnique({ where: { id: task.assignee.id }, select: { telegramId: true } })
        .then((emp) => this.bot?.sendMessage(emp?.telegramId, `Вам назначена задача: «${task.title}»${due}`));
    }
    return result;
  }

  // «Разберитесь сами» — тоже из очереди или из вызова.
  async delegate(owner: AuthenticatedUser, id: string, dto: DelegateReceptionRequestDto) {
    return this.closeByOwner(owner, id, dto.version, 'DELEGATED', normalizeOptionalText(dto.comment));
  }

  private async closeByOwner(
    owner: AuthenticatedUser,
    id: string,
    expectedVersion: number,
    toStatus: 'ANSWERED' | 'DELEGATED',
    resolution: string | null,
    task?: AnswerTaskDto,
  ) {
    const request = await this.prisma.$transaction(async (tx) => {
      const current = await tx.receptionRequest.findUnique({
        where: { id },
        select: { status: true, authorId: true, title: true, description: true },
      });
      if (!current) throw new NotFoundException('Обращение не найдено');
      if (current.status !== 'WAITING' && current.status !== 'CALLED') {
        throw new ConflictException('INVALID_TRANSITION: обращение уже закрыто');
      }
      const fromStatus = current.status;
      const taskTitle = task?.title.trim();
      const assigneeId = task?.assigneeId ?? current.authorId;
      if (task) {
        if (!taskTitle) throw new BadRequestException('Укажите название задачи');
        const assignee = await tx.employee.findFirst({ where: { id: assigneeId, status: 'ACTIVE' }, select: { id: true } });
        if (!assignee) throw new BadRequestException('Исполнитель задачи не найден или неактивен');
      }

      const result = await tx.receptionRequest.updateMany({
        where: { id, version: expectedVersion, status: fromStatus },
        data: { status: toStatus, version: { increment: 1 }, closedAt: new Date(), resolution },
      });
      if (result.count === 0) throw await this.classifyTransitionFailure(tx, id, undefined, expectedVersion, fromStatus);

      if (task && taskTitle) {
        const created = await tx.task.create({
          data: {
            title: taskTitle,
            description: `Вопрос из приёмной: «${current.title}»\n${current.description}\n\nОтвет руководителя:\n${resolution ?? ''}`,
            assigneeId,
            creatorId: owner.id,
            status: 'NEW',
            dueDate: task.dueDate ? new Date(task.dueDate) : undefined,
          },
          select: { id: true },
        });
        await tx.receptionRequest.update({ where: { id }, data: { taskId: created.id } });
      }

      const updated = await tx.receptionRequest.findUniqueOrThrow({ where: { id }, select: DETAIL_SELECT });
      const event = await tx.receptionEvent.create({
        data: { requestId: id, actorId: owner.id, type: toStatus, fromStatus, toStatus, requestVersion: updated.version },
      });
      // Ещё не отправленное «вас приглашают» больше не актуально.
      await tx.receptionNotification.updateMany({
        where: { requestId: id, kind: 'CALLED', status: 'PENDING' },
        data: { status: 'SUPERSEDED' },
      });
      await tx.receptionNotification.create({
        data: { eventId: event.id, requestId: id, recipientId: updated.authorId, kind: toStatus },
      });
      return updated;
    });
    return serializeRequest(request);
  }

  // --- шаблоны быстрых ответов ---

  listTemplates() {
    return this.prisma.receptionAnswerTemplate.findMany({
      select: { id: true, text: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createTemplate(text: string) {
    const normalized = text.trim();
    if (!normalized) throw new BadRequestException('Пустой шаблон');
    const existing = await this.prisma.receptionAnswerTemplate.findFirst({ where: { text: normalized }, select: { id: true, text: true } });
    if (existing) return existing;
    const count = await this.prisma.receptionAnswerTemplate.count();
    if (count >= MAX_ANSWER_TEMPLATES) throw new BadRequestException(`Не больше ${MAX_ANSWER_TEMPLATES} шаблонов — удалите ненужные`);
    const { _max } = await this.prisma.receptionAnswerTemplate.aggregate({ _max: { sortOrder: true } });
    return this.prisma.receptionAnswerTemplate.create({
      data: { text: normalized, sortOrder: (_max.sortOrder ?? 0) + 1 },
      select: { id: true, text: true },
    });
  }

  async deleteTemplate(id: string) {
    const { count } = await this.prisma.receptionAnswerTemplate.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException('Шаблон не найден');
    return { ok: true };
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
    if (!isManager(actor.role) && request.authorId !== actor.id) throw new NotFoundException('Обращение не найдено');
    return serializeRequest(request);
  }

  // Скачивание вложения — те же права, что на само обращение (автор или
  // руководство); чужой/несуществующий — 404.
  async assertAttachmentAccess(actor: AuthenticatedUser, requestId: string, fileId: string): Promise<void> {
    await this.getOne(actor, requestId);
    const attachment = await this.prisma.receptionAttachment.findFirst({ where: { requestId, fileId }, select: { id: true } });
    if (!attachment) throw new NotFoundException('Файл не найден');
  }

  async getMine(actor: AuthenticatedUser, scope: 'active' | 'history', limit: number, offset: number) {
    const statuses: ReceptionRequestStatus[] = scope === 'active' ? ['WAITING', 'CALLED'] : CLOSED_STATUSES;
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

  // Доска руководителя (владелец 20.10.2026): очередь, текущий вызов и
  // закрытые за неделю — «Разберитесь сами» и «Отвечено» (ответ без
  // встречи + обсуждённые лично).
  async getBoard() {
    const recentSince = new Date(Date.now() - BOARD_RECENT_DAYS * 24 * 60 * 60 * 1000);
    const recent = (statuses: ReceptionRequestStatus[]) =>
      this.prisma.receptionRequest.findMany({
        where: { queueId: QUEUE_ID, status: { in: statuses }, closedAt: { gte: recentSince } },
        select: DETAIL_SELECT,
        orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
        take: BOARD_RECENT_LIMIT,
      });
    const [queue, delegated, answered] = await Promise.all([
      this.getQueueView({}, BOARD_WAITING_LIMIT, 0),
      recent(['DELEGATED']),
      recent(['ANSWERED', 'COMPLETED']),
    ]);
    return {
      current: queue.current,
      waiting: queue.items,
      totalWaiting: queue.totalWaiting,
      delegated: delegated.map(serializeRequest),
      answered: answered.map(serializeRequest),
    };
  }

  async getHistory(
    filters: { authorId?: string; status?: ReceptionRequestStatus; closedFrom?: Date; closedTo?: Date },
    limit: number,
    offset: number,
  ) {
    const where: Prisma.ReceptionRequestWhereInput = {
      queueId: QUEUE_ID,
      status: { in: CLOSED_STATUSES },
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
    if (!isManager(actor.role) && request.authorId !== actor.id) throw new NotFoundException('Обращение не найдено');
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

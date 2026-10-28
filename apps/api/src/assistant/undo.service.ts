import { Injectable, Logger } from '@nestjs/common';
import { MessagePartType, MessageRole, MessageStatus, Prisma, UndoKind, UndoRecordAction, UndoRecordStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { isManager } from '../auth/roles';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../calendar/events.service';
import type { UpdateTaskDto } from '../tasks/dto/update-task.dto';
import type { UpdateEventDto } from '../calendar/dto/update-event.dto';
import type { EventRevertPayload, TaskRevertPayload } from '../voice/dto/voice-draft-response.dto';
import type { VoiceUndoDto } from '../voice/dto/voice-undo.dto';
import { AssistantChatService } from './assistant-chat.service';

// Отмена действий ассистента (единый агент A4, docs/AGENT_AND_MEETINGS.md) —
// перенесена из VoiceService как есть: откат по снимку UndoRecord, который
// сервер сам сохранил сразу после изменения (Phase H.4), атомарный claim и
// статусы AVAILABLE → CLAIMED → COMPLETED/PARTIAL (Phase L/N). Записи создают
// голос (VoiceService.executeTaskAction/executeEventAction) и инструменты
// чата (AssistantToolsService, A2–A3); отменяют POST /assistant/undo и
// прежний POST /voice/undo — один и тот же метод.

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Не удалось выполнить действие';
}

// P2025 — «запись под where не найдена»: конкурентный запрос уже забрал отмену.
function isRecordNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

@Injectable()
export class UndoService {
  private readonly logger = new Logger(UndoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly events: EventsService,
    private readonly assistantChat: AssistantChatService,
  ) {}

  // Отдельное ("standalone") assistant-сообщение без replyToMessageId (ни
  // на какое user-сообщение не отвечает) в общей ленте — сейчас единственный
  // вызывающий это undo() ниже. Stage 2, Phase H.1 (аудит 20.09.2026,
  // P0/P1) — раньше был отдельным публичным эндпоинтом POST /voice/messages
  // с произвольным текстом от клиента (conversation-history poisoning —
  // см. комментарий у VoiceUndoDto); текст теперь всегда решает сервер, не
  // клиент, поэтому метод стал private.
  // conversationId (единый агент A2) — разговор, где показана карточка с
  // «Отменить»; только свой — иначе, как раньше, основной разговор.
  async logAssistantMessage(text: string, user: AuthenticatedUser, conversationId?: string | null): Promise<void> {
    const own = conversationId ? await this.prisma.conversation.findFirst({ where: { id: conversationId, employeeId: user.id }, select: { id: true } }) : null;
    const conversation = own ?? (await this.assistantChat.getOrCreatePrimaryConversation(user));
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: MessageRole.ASSISTANT,
        status: MessageStatus.COMPLETED,
        parts: { create: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: text } }] },
      },
    });
  }

  // POST /voice/undo (Stage 2, Phase H.1 → H.4) — заменяет прежний паттерн
  // "фронтенд сам откатывает через PATCH/DELETE, потом просит сервер
  // записать придуманный текст" (POST /voice/messages). Phase H.4 (внешний
  // аудит 21.09.2026, "trusted server-side undo") пошла дальше: раньше
  // dto нёс authoritative previous/addedParticipantIds/removedParticipantIds
  // от клиента — устаревший/подделанный payload мог откатить сущность в
  // состояние, которого никогда не было. Теперь dto — только undoToken
  // (id UndoRecord, который сервер сам создал и сохранил сразу после
  // мутации, см. createUndoRecord/executeTaskAction/executeEventAction) —
  // клиент больше не authoritative источник отката.
  //
  // Один общий безопасный текст на "не найдено"/"чужое"/"уже
  // отменено"/"истекло" — тот же принцип "не раскрываем, какой из
  // случаев", что и у 404 при скачивании чужого файла (FilesService).
  // Stage 2, Phase L (внешний аудит 21.09.2026, "Undo consistency", P1) —
  // раньше "занято" (consumedAt) ставилось СРАЗУ при claim'е, ДО попытки
  // самого отката — если сам откат падал (TasksService.update и т.п.
  // бросали), запись оставалась помеченной использованной НАВСЕГДА, и
  // повторный клик "Отменить" получал generic-отказ, хотя откат так и не
  // произошёл. Теперь статус — явный конечный автомат: AVAILABLE →
  // CLAIMED (атомарно, тот же приём P2025 через where) → COMPLETED (откат
  // реально удался) или обратно в AVAILABLE (откат упал — в пределах
  // expiresAt пользователь может нажать "Отменить" ещё раз).
  async undo(dto: VoiceUndoDto, user: AuthenticatedUser): Promise<{ ok: boolean; error: string | null; warning: string | null }> {
    const genericError = 'Время для отмены истекло, действие уже отменено, или ссылка на отмену недействительна.';
    const record = await this.prisma.undoRecord.findUnique({ where: { id: dto.undoToken } });
    if (!record || record.employeeId !== user.id || record.expiresAt.getTime() < Date.now()) {
      await this.logAssistantMessage(`Не получилось отменить: ${genericError}`, user).catch(() => {});
      return { ok: false, error: genericError, warning: null };
    }

    // Защитная проверка роли — та же RBAC-проверка, не задвоена:
    // TasksService.update/remove сами проверяют постановщика/руководителя,
    // EventsService — по факту, что модуль целиком закрыт на OWNER.
    // Кнопка "Отменить" для события в принципе не показывается не-OWNER на
    // фронте, но это не граница безопасности сама по себе (тот же принцип,
    // что и у enforceEventRbac).
    if (record.kind === UndoKind.EVENT && !isManager(user.role)) {
      const error = 'Календарь доступен только руководителю — отменить это действие может только он.';
      await this.logAssistantMessage(`Не получилось отменить: ${error}`, user, record.conversationId).catch(() => {});
      return { ok: false, error, warning: null };
    }

    // Атомарный claim — where: {id, status: AVAILABLE} закрывает узкую
    // гонку двойного одновременного POST /voice/undo с одним undoToken:
    // если конкурентный запрос уже успел перевести статус между findUnique
    // выше и этим update, where больше не matches ни одной строки, Prisma
    // бросает P2025 вместо того, чтобы молча обновить нулём строк — этот
    // запрос откатывается на безопасный "уже отменено", не выполняет
    // мутацию повторно.
    try {
      await this.prisma.undoRecord.update({ where: { id: record.id, status: UndoRecordStatus.AVAILABLE }, data: { status: UndoRecordStatus.CLAIMED } });
    } catch (err) {
      if (isRecordNotFoundError(err)) {
        return { ok: false, error: genericError, warning: null };
      }
      throw err;
    }

    const participantFailures: string[] = [];
    try {
      if (record.kind === UndoKind.TASK) {
        if (record.action === UndoRecordAction.CREATE) {
          await this.tasks.remove(record.entityId, user);
        } else {
          const previous = (record.previous ?? {}) as TaskRevertPayload;
          const patch: UpdateTaskDto = {};
          if (previous.title !== undefined) patch.title = previous.title;
          if (previous.description !== undefined) patch.description = previous.description;
          if (previous.assigneeId !== undefined) patch.assigneeId = previous.assigneeId;
          if (previous.dueDate !== undefined) patch.dueDate = previous.dueDate;
          if (previous.priority !== undefined) patch.priority = previous.priority;
          // Единый агент A2: смена статуса из чата откатывается через
          // updateStatus (его права — у исполнителя, не у постановщика), а
          // update с пустым патчем не вызываем — исполнителю он запрещён.
          if (Object.keys(patch).length > 0) await this.tasks.update(record.entityId, patch, user);
          if (previous.status !== undefined) await this.tasks.updateStatus(record.entityId, previous.status, user);
        }
      } else {
        if (record.action === UndoRecordAction.CREATE) {
          await this.events.remove(record.entityId, user.id);
        } else {
          const previous = (record.previous ?? {}) as EventRevertPayload;
          const patch: UpdateEventDto = {};
          if (previous.title !== undefined) patch.title = previous.title;
          if (previous.description !== undefined) patch.description = previous.description;
          if (previous.location !== undefined) patch.location = previous.location;
          if (previous.startAt !== undefined) patch.startAt = previous.startAt;
          if (previous.endAt !== undefined) patch.endAt = previous.endAt;
          if (previous.allDay !== undefined) patch.allDay = previous.allDay;
          if (Object.keys(patch).length > 0) await this.events.update(record.entityId, patch, user.id);
          // Инверсия: то, что исходное действие ДОБАВИЛО, undo СНИМАЕТ, и
          // наоборот — тот же смысл, что уже был в прежнем клиентском
          // performUndo (обеих фронтендов), просто выполняется здесь.
          //
          // Находка №6 шестого внешнего аудита (Stage 2, Phase M) — раньше
          // сбой отката отдельного участника проходил полностью бесследно
          // (`.catch(() => {})`) — не только для клиента (тот же decoupling-
          // принцип здесь оправдан: остальная часть отката события уже
          // произошла, превращать весь undo в ok:false из-за одного
          // участника было бы неверно), но и для логов — диагностировать
          // такой сбой раньше было нечем. Теперь как минимум логируется.
          //
          // Находка №2 седьмого внешнего аудита (Stage 2, Phase N) —
          // логирования одного было недостаточно: запись всё равно
          // становилась COMPLETED, и пользователь видел "Отменено.", хотя
          // откат участников прошёл не полностью. Теперь собираем сбои и
          // ниже выставляем PARTIAL вместо COMPLETED, если хоть один был.
          const addedParticipantIds = (record.addedParticipantIds ?? []) as string[];
          const removedParticipantIds = (record.removedParticipantIds ?? []) as string[];
          for (const employeeId of addedParticipantIds) {
            await this.events.removeParticipant(record.entityId, employeeId, user.id).catch((err) => {
              const message = `не удалось откатить добавленного участника ${employeeId}: ${toErrorMessage(err)}`;
              this.logger.warn(`undo: ${message} (событие ${record.entityId})`);
              participantFailures.push(message);
            });
          }
          for (const employeeId of removedParticipantIds) {
            await this.events.addParticipant(record.entityId, employeeId, user.id).catch((err) => {
              const message = `не удалось восстановить снятого участника ${employeeId}: ${toErrorMessage(err)}`;
              this.logger.warn(`undo: ${message} (событие ${record.entityId})`);
              participantFailures.push(message);
            });
          }
        }
      }
      const warning = participantFailures.length > 0 ? participantFailures.join('; ') : null;
      await this.prisma.undoRecord.update({
        where: { id: record.id },
        data: { status: warning ? UndoRecordStatus.PARTIAL : UndoRecordStatus.COMPLETED, consumedAt: new Date() },
      });
      // Логирование подтверждения — вторичный эффект, не должен превращать
      // уже случившийся успешный откат в ok:false для клиента (тот же
      // принцип, что и graceful degradation в runParse, Phase H.1).
      await this.logAssistantMessage(warning ? `Отменено частично. ${warning}` : 'Отменено.', user, record.conversationId).catch(() => {});
      return { ok: true, error: null, warning };
    } catch (err) {
      const error = toErrorMessage(err);
      // Откат не удался — возвращаем запись в AVAILABLE (best-effort, в
      // своём catch: сбой этого шага не должен маскировать реальную
      // причину сбоя отката), чтобы пользователь мог нажать "Отменить" ещё
      // раз в пределах expiresAt, а не получал "уже отменено" на ровном месте.
      await this.prisma.undoRecord.update({ where: { id: record.id }, data: { status: UndoRecordStatus.AVAILABLE } }).catch(() => {});
      await this.logAssistantMessage(`Не получилось отменить: ${error}`, user, record.conversationId).catch(() => {});
      return { ok: false, error, warning: null };
    }
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Conversation, FileArtifact, Message, MessagePart, MessageRole, MessageStatus, MessagePartType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { FilesService } from '../files/files.service';
import { AssistantReplyService, type ReplyHistoryItem } from './assistant-reply.service';
import { buildAssistantParts, toolActivityLabel, type MessagePartInput } from './assistant-render';
import { SendMessageDto } from './dto/send-message.dto';
import type { MarkdownPartData, TaskCardData, EventCardData, FilePartData } from './dto/message-part-data.dto';

// Сколько предыдущих сообщений разговора отдавать модели как историю — тот
// же порядок величины, что VOICE_HISTORY_LIMIT в voice.service.ts, здесь не
// делится по времени (в отличие от voice): один Conversation — один
// логически непрерывный диалог, а не заметки, между которыми могло пройти
// много часов.
const HISTORY_LIMIT = 20;

export type MessageWithParts = Message & { parts: MessagePart[] };

// Внутренний (Prisma-представление) событийный контракт стриминга —
// AssistantChatController переводит его в публичный StreamEvent
// (dto/stream-event.dto.ts) на границе, тем же приёмом, что
// toResponseMessage для non-streaming ответа (assistant-response.mapper.ts)
// — сервис не должен знать формат HTTP-ответа.
export type InternalStreamEvent =
  | { event: 'message.started'; messageId: string }
  | { event: 'part.started'; messageId: string; partId: string }
  | { event: 'part.delta'; messageId: string; partId: string; delta: string }
  | { event: 'part.completed'; messageId: string; partId: string; part: MessagePart }
  | { event: 'tool.started'; messageId: string; tool: string }
  | { event: 'tool.completed'; messageId: string; tool: string; label: string }
  | { event: 'message.completed'; messageId: string; message: MessageWithParts }
  | { event: 'message.failed'; messageId: string; error: string };

const ASSISTANT_TEXT_PART_ID = 'assistant-text';
const GENERIC_FAILURE_MESSAGE = 'Не удалось получить ответ ассистента. Попробуйте ещё раз.';

// Phase F.1 (стабилизация, аудит 16.09.2026) — раньше история для модели
// собиралась только из MARKDOWN-частей: карточки задач/событий/файлы,
// показанные пользователю, физически не попадали в следующий контекст —
// "расскажи подробнее про первую [задачу из карточек]" модель не могла
// связать ни с чем. Компактное текстовое представление, не сырой JSON
// MessagePart.data целиком — модель получает id/title/статус, не весь
// внутренний объект. tool_activity/error намеренно пропускаются — статус
// "проверяю задачи" или текст ошибки не несут содержательного контекста
// для следующего вопроса пользователя.
function serializeMessageForModelContext(parts: MessagePart[]): string {
  return parts
    .map((p) => {
      switch (p.type) {
        case MessagePartType.MARKDOWN:
          return (p.data as MarkdownPartData).content;
        case MessagePartType.TASK_CARD: {
          const d = p.data as TaskCardData;
          return `[shown_task]\nid=${d.taskId}\ntitle=${d.title}\nstatus=${d.status}`;
        }
        case MessagePartType.EVENT_CARD: {
          const d = p.data as EventCardData;
          return `[shown_event]\nid=${d.eventId}\ntitle=${d.title}\nstartAt=${d.startAt}`;
        }
        case MessagePartType.FILE: {
          const d = p.data as FilePartData;
          return `[file]\nid=${d.fileId}\nname=${d.name}\nmimeType=${d.mimeType}`;
        }
        default:
          return null;
      }
    })
    .filter((s): s is string => Boolean(s))
    .join('\n');
}

// Stage 2. Phase B — персист + один обычный (без tool use) ответ. Phase C
// — tool-calling (get_tasks/get_events, см. assistant-tools.service.ts).
// Phase E — то же самое, но с прогрессом по мере готовности (streamMessage),
// поверх ОДНОГО и того же AssistantReplyService.runReply — никакой
// отдельной бизнес-логики для стриминга, только другой способ её показать.
// Phase F.1 — стабилизация (см. комментарии у replyToMessageId/loadHistory/
// serializeMessageForModelContext ниже). Существующий voice-путь
// (VoiceService, /voice/parse) не переиспользует эти таблицы и не
// изменяется этим сервисом.
@Injectable()
export class AssistantChatService {
  private readonly logger = new Logger(AssistantChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reply: AssistantReplyService,
    private readonly files: FilesService,
  ) {}

  // MVP (Stage 2 §4.1): у каждого сотрудника должен быть хотя бы один
  // диалог — при первом обращении список пуст, создаём диалог лениво прямо
  // здесь, а не отдельным onboarding-шагом или отдельным эндпоинтом.
  // Полноценный список из нескольких чатов уже возможен архитектурно
  // (createConversation ниже), просто фронтенду пока некуда показывать
  // больше одного.
  async listConversations(user: AuthenticatedUser): Promise<Conversation[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: { employeeId: user.id },
      orderBy: { updatedAt: 'desc' },
    });
    if (conversations.length > 0) return conversations;
    return [await this.createConversation(user)];
  }

  async createConversation(user: AuthenticatedUser, title?: string): Promise<Conversation> {
    return this.prisma.conversation.create({
      data: { employeeId: user.id, title: title || null },
    });
  }

  private async findOwnedConversation(user: AuthenticatedUser, conversationId: string): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    // 404, не 403 — чужому сотруднику не подтверждаем даже факт
    // существования чужого разговора (тот же принцип, что validateTarget
    // в voice.service.ts для чужих/неизвестных id).
    if (!conversation || conversation.employeeId !== user.id) {
      throw new NotFoundException('Диалог не найден');
    }
    return conversation;
  }

  // Публичный тонкий алиас — AssistantChatController зовёт его ДО открытия
  // SSE-потока (Phase E), чтобы 404 на чужой разговор пришёл обычным
  // JSON-ответом, а не потерялся бы внутри уже открытого text/event-stream.
  async assertOwnedConversation(user: AuthenticatedUser, conversationId: string): Promise<void> {
    await this.findOwnedConversation(user, conversationId);
  }

  async getMessages(user: AuthenticatedUser, conversationId: string): Promise<MessageWithParts[]> {
    await this.findOwnedConversation(user, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      include: { parts: { orderBy: { order: 'asc' } } },
    });
  }

  // Идемпотентность (Stage 2 §29) — тот же clientRequestId в этом же
  // разговоре означает "это тот же самый запрос отправки". Общий для
  // sendMessage/streamMessage. ВАЖНО: короткое замыкание срабатывает,
  // только если вызывающий код сам проверит assistantMessage?.status ===
  // COMPLETED — эта функция лишь ищет пару, решение "повторять или нет"
  // принимает вызывающий (см. комментарий у sendMessage ниже про
  // FAILED-ответы).
  //
  // Phase F.1 (аудит 16.09.2026) — пара ищется через явный
  // replyToMessageId, не через "первое assistant-сообщение с createdAt
  // позже user-сообщения": на двух устройствах, отправляющих сообщения
  // почти одновременно, время не гарантирует правильное сопоставление —
  // ответ B физически мог прийти раньше ответа на A.
  private async findExistingPair(
    conversationId: string,
    clientRequestId: string | undefined,
  ): Promise<{ userMessage: MessageWithParts; assistantMessage: MessageWithParts | null } | null> {
    if (!clientRequestId) return null;
    const userMessage = await this.prisma.message.findUnique({
      where: { conversationId_clientRequestId: { conversationId, clientRequestId } },
      include: { parts: { orderBy: { order: 'asc' } } },
    });
    if (!userMessage) return null;
    const assistantMessage = await this.prisma.message.findFirst({
      where: { replyToMessageId: userMessage.id },
      include: { parts: { orderBy: { order: 'asc' } } },
    });
    return { userMessage, assistantMessage };
  }

  // excludeMessageId — Phase F.1 (аудит 16.09.2026): раньше history
  // грузилась ПОСЛЕ того, как user-сообщение уже было в БД (в т.ч. при
  // retry — то же сообщение, что мы сейчас же и обрабатываем), поэтому
  // текущий вопрос попадал в historyForModel, а затем runReply ещё раз
  // добавлял dto.text отдельным элементом — модель получала вопрос
  // дважды. Явное исключение убирает дубль, не завязываясь на то, вызван
  // ли loadHistory до или после создания строки.
  private async loadHistory(conversationId: string, excludeMessageId: string): Promise<ReplyHistoryItem[]> {
    const history = await this.prisma.message.findMany({
      where: { conversationId, id: { not: excludeMessageId } },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      include: { parts: { orderBy: { order: 'asc' } } },
    });
    return history
      .reverse()
      .map((m) => ({
        role: m.role === MessageRole.USER ? ('user' as const) : ('assistant' as const),
        text: serializeMessageForModelContext(m.parts),
      }))
      .filter((h) => h.text);
  }

  // Phase F — вложения. Невалидный/чужой id внутри attachmentIds не роняет
  // отправку сообщения целиком (тот же fail-safe принцип, что невалидный
  // assigneeId в voice.service.ts) — просто не попадает в результат.
  // Владение проверяется здесь, не полагаемся на то, что клиент прислал
  // только свои же id (спека Stage 2 §30).
  private async resolveAttachments(user: AuthenticatedUser, attachmentIds: string[] | undefined): Promise<FileArtifact[]> {
    if (!attachmentIds?.length) return [];
    const resolved: FileArtifact[] = [];
    for (const id of attachmentIds) {
      try {
        resolved.push(await this.files.assertOwnedFile(user, id));
      } catch {
        // чужой/несуществующий id — тихо пропускаем
      }
    }
    return resolved;
  }

  private buildUserMessagePartsInput(text: string, attachments: FileArtifact[]): MessagePartInput[] {
    const parts: MessagePartInput[] = [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: text } }];
    attachments.forEach((f, i) => {
      parts.push({
        type: MessagePartType.FILE,
        order: i + 1,
        data: { fileId: f.id, name: f.name, mimeType: f.mimeType, size: f.size },
      });
    });
    return parts;
  }

  // Файл существует и уже принадлежит сотруднику (source: UPLOADED) с
  // момента POST /files/upload — здесь он только привязывается к
  // конкретному сообщению/разговору постфактум (conversationId/messageId
  // были null до этого момента).
  private async linkAttachments(conversationId: string, messageId: string, attachments: FileArtifact[]): Promise<void> {
    if (!attachments.length) return;
    await this.prisma.fileArtifact.updateMany({
      where: { id: { in: attachments.map((f) => f.id) } },
      data: { conversationId, messageId },
    });
  }

  private sumToolExecutionMs(toolCalls: { durationMs: number }[]): number {
    return toolCalls.reduce((sum, c) => sum + c.durationMs, 0);
  }

  async sendMessage(
    user: AuthenticatedUser,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<{ userMessage: MessageWithParts; assistantMessage: MessageWithParts }> {
    await this.findOwnedConversation(user, conversationId);

    // Короткое замыкание — только на настоящий успех. Раньше (Phase B/C)
    // оно срабатывало на любой статус, включая FAILED — то есть повторная
    // отправка после реального сбоя ассистента никогда не повторяла
    // попытку, просто отдавала тот же FAILED результат снова. Теперь
    // FAILED считается "настоящего ответа ещё не было" — ниже идём на
    // новую попытку, обновляя ту же строку (не дублируя её).
    const existing = await this.findExistingPair(conversationId, dto.clientRequestId);
    if (existing?.assistantMessage?.status === MessageStatus.COMPLETED) {
      return { userMessage: existing.userMessage, assistantMessage: existing.assistantMessage };
    }

    const requestId = randomUUID();
    const t0 = Date.now();

    let userMessage: MessageWithParts;
    if (existing?.userMessage) {
      userMessage = existing.userMessage;
    } else {
      const attachments = await this.resolveAttachments(user, dto.attachmentIds);
      userMessage = await this.prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.USER,
          status: MessageStatus.COMPLETED,
          clientRequestId: dto.clientRequestId || null,
          parts: { create: this.buildUserMessagePartsInput(dto.text, attachments) },
        },
        include: { parts: { orderBy: { order: 'asc' } } },
      });
      await this.linkAttachments(conversationId, userMessage.id, attachments);
    }

    const history = await this.loadHistory(conversationId, userMessage.id);

    let assistantMessage: MessageWithParts;
    let toolNames: string[] = [];
    let toolExecutionMs = 0;
    try {
      const result = await this.reply.reply(dto.text, history, user);
      toolNames = result.toolCalls.map((c) => c.name);
      toolExecutionMs = this.sumToolExecutionMs(result.toolCalls);
      const partsInput = buildAssistantParts(result);
      assistantMessage = existing?.assistantMessage
        ? await this.prisma.message.update({
            where: { id: existing.assistantMessage.id },
            data: { status: MessageStatus.COMPLETED, requestId, replyToMessageId: userMessage.id, parts: { deleteMany: {}, create: partsInput } },
            include: { parts: { orderBy: { order: 'asc' } } },
          })
        : await this.prisma.message.create({
            data: {
              conversationId,
              role: MessageRole.ASSISTANT,
              status: MessageStatus.COMPLETED,
              requestId,
              replyToMessageId: userMessage.id,
              parts: { create: partsInput },
            },
            include: { parts: { orderBy: { order: 'asc' } } },
          });
    } catch (err) {
      // Техническая ошибка — только в логи (Stage 2 §5.6/§32); пользователю
      // уходит безопасный текст через ErrorPart.
      this.logger.error(`assistant reply reqId=${requestId} failed: ${err instanceof Error ? err.message : err}`);
      const errorPart = [{ type: MessagePartType.ERROR, order: 0, data: { message: GENERIC_FAILURE_MESSAGE } }];
      assistantMessage = existing?.assistantMessage
        ? await this.prisma.message.update({
            where: { id: existing.assistantMessage.id },
            data: { status: MessageStatus.FAILED, requestId, replyToMessageId: userMessage.id, parts: { deleteMany: {}, create: errorPart } },
            include: { parts: { orderBy: { order: 'asc' } } },
          })
        : await this.prisma.message.create({
            data: {
              conversationId,
              role: MessageRole.ASSISTANT,
              status: MessageStatus.FAILED,
              requestId,
              replyToMessageId: userMessage.id,
              parts: { create: errorPart },
            },
            include: { parts: { orderBy: { order: 'asc' } } },
          });
    }

    await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });

    this.logger.log(
      `assistant chat reqId=${requestId} conversationId=${conversationId} status=${assistantMessage.status} ` +
        `toolsCalled=${toolNames.length ? toolNames.join(',') : 'none'} toolExecutionMs=${toolExecutionMs} ` +
        `chatRequestMs=${Date.now() - t0}`,
    );

    return { userMessage, assistantMessage };
  }

  // Phase E — тот же поток, что sendMessage, но прогресс отдаётся через
  // emit() по мере готовности вместо одного блокирующего ответа. abortSignal
  // — обрыв соединения с клиентом (AssistantChatController слушает
  // res.on('close')) прерывает реальный HTTP-запрос к Anthropic.
  async streamMessage(
    user: AuthenticatedUser,
    conversationId: string,
    dto: SendMessageDto,
    emit: (event: InternalStreamEvent) => void,
    abortSignal: AbortSignal,
  ): Promise<void> {
    await this.findOwnedConversation(user, conversationId);

    const existing = await this.findExistingPair(conversationId, dto.clientRequestId);
    if (existing?.assistantMessage?.status === MessageStatus.COMPLETED) {
      emit({ event: 'message.started', messageId: existing.assistantMessage.id });
      emit({ event: 'message.completed', messageId: existing.assistantMessage.id, message: existing.assistantMessage });
      return;
    }

    const requestId = randomUUID();
    const t0 = Date.now();

    // В отличие от sendMessage, здесь сам объект пользовательского
    // сообщения стриминговым событиям не нужен (клиент уже показал его
    // оптимистично) — но персистить его всё равно нужно, если это не
    // повтор уже существующей пары.
    let userMessageId: string;
    if (existing?.userMessage) {
      userMessageId = existing.userMessage.id;
    } else {
      const attachments = await this.resolveAttachments(user, dto.attachmentIds);
      const createdUserMessage = await this.prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.USER,
          status: MessageStatus.COMPLETED,
          clientRequestId: dto.clientRequestId || null,
          parts: { create: this.buildUserMessagePartsInput(dto.text, attachments) },
        },
      });
      userMessageId = createdUserMessage.id;
      await this.linkAttachments(conversationId, userMessageId, attachments);
    }

    const history = await this.loadHistory(conversationId, userMessageId);

    const assistantMessage =
      existing?.assistantMessage ??
      (await this.prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.ASSISTANT,
          status: MessageStatus.STREAMING,
          requestId,
          replyToMessageId: userMessageId,
          parts: { create: [] },
        },
        include: { parts: { orderBy: { order: 'asc' } } },
      }));

    emit({ event: 'message.started', messageId: assistantMessage.id });
    emit({ event: 'part.started', messageId: assistantMessage.id, partId: ASSISTANT_TEXT_PART_ID });

    const toolNames: string[] = [];
    let firstTokenAt: number | null = null;
    try {
      const result = await this.reply.streamReply(
        dto.text,
        history,
        user,
        (e) => {
          if (e.type === 'text-reset') {
            emit({ event: 'part.started', messageId: assistantMessage.id, partId: ASSISTANT_TEXT_PART_ID });
          } else if (e.type === 'text-delta') {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            emit({ event: 'part.delta', messageId: assistantMessage.id, partId: ASSISTANT_TEXT_PART_ID, delta: e.delta });
          } else if (e.type === 'tool-started') {
            emit({ event: 'tool.started', messageId: assistantMessage.id, tool: e.name });
          } else if (e.type === 'tool-completed') {
            toolNames.push(e.name);
            emit({ event: 'tool.completed', messageId: assistantMessage.id, tool: e.name, label: toolActivityLabel(e.result).label });
          }
        },
        abortSignal,
      );

      const toolExecutionMs = this.sumToolExecutionMs(result.toolCalls);
      const partsInput = buildAssistantParts(result);
      const updated = await this.prisma.message.update({
        where: { id: assistantMessage.id },
        data: { status: MessageStatus.COMPLETED, requestId, parts: { deleteMany: {}, create: partsInput } },
        include: { parts: { orderBy: { order: 'asc' } } },
      });
      for (const part of updated.parts) {
        emit({ event: 'part.completed', messageId: assistantMessage.id, partId: part.id, part });
      }
      emit({ event: 'message.completed', messageId: assistantMessage.id, message: updated });

      await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      this.logger.log(
        `assistant chat reqId=${requestId} conversationId=${conversationId} status=COMPLETED ` +
          `toolsCalled=${toolNames.length ? toolNames.join(',') : 'none'} toolExecutionMs=${toolExecutionMs} ` +
          `timeToFirstTokenMs=${firstTokenAt !== null ? firstTokenAt - t0 : 'n/a'} chatRequestMs=${Date.now() - t0}`,
      );
    } catch (err) {
      this.logger.error(`assistant reply reqId=${requestId} failed (streaming): ${err instanceof Error ? err.message : err}`);
      await this.prisma.message.update({
        where: { id: assistantMessage.id },
        data: {
          status: MessageStatus.FAILED,
          requestId,
          parts: { deleteMany: {}, create: [{ type: MessagePartType.ERROR, order: 0, data: { message: GENERIC_FAILURE_MESSAGE } }] },
        },
      });
      emit({ event: 'message.failed', messageId: assistantMessage.id, error: GENERIC_FAILURE_MESSAGE });
      await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      this.logger.log(
        `assistant chat reqId=${requestId} conversationId=${conversationId} status=FAILED streaming=true chatRequestMs=${Date.now() - t0}`,
      );
    }
  }
}

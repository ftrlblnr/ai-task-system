import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Conversation, Message, MessagePart, MessageRole, MessageStatus, MessagePartType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantReplyService } from './assistant-reply.service';
import { buildAssistantParts, toolActivityLabel } from './assistant-render';
import { SendMessageDto } from './dto/send-message.dto';

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

// Stage 2. Phase B — персист + один обычный (без tool use) ответ. Phase C
// — tool-calling (get_tasks/get_events, см. assistant-tools.service.ts).
// Phase E — то же самое, но с прогрессом по мере готовности (streamMessage),
// поверх ОДНОГО и того же AssistantReplyService.runReply — никакой
// отдельной бизнес-логики для стриминга, только другой способ её показать.
// Существующий voice-путь (VoiceService, /voice/parse) не переиспользует
// эти таблицы и не изменяется этим сервисом.
@Injectable()
export class AssistantChatService {
  private readonly logger = new Logger(AssistantChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reply: AssistantReplyService,
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
      where: { conversationId, role: MessageRole.ASSISTANT, createdAt: { gt: userMessage.createdAt } },
      orderBy: { createdAt: 'asc' },
      include: { parts: { orderBy: { order: 'asc' } } },
    });
    return { userMessage, assistantMessage };
  }

  private async loadHistory(conversationId: string): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
    const history = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      include: { parts: { where: { type: MessagePartType.MARKDOWN }, orderBy: { order: 'asc' }, take: 1 } },
    });
    return history
      .reverse()
      .map((m) => ({
        role: m.role === MessageRole.USER ? ('user' as const) : ('assistant' as const),
        text: (m.parts[0]?.data as { content?: string } | undefined)?.content ?? '',
      }))
      .filter((h) => h.text);
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
    const history = await this.loadHistory(conversationId);

    const userMessage =
      existing?.userMessage ??
      (await this.prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.USER,
          status: MessageStatus.COMPLETED,
          clientRequestId: dto.clientRequestId || null,
          parts: { create: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: dto.text } }] },
        },
        include: { parts: { orderBy: { order: 'asc' } } },
      }));

    let assistantMessage: MessageWithParts;
    let toolNames: string[] = [];
    try {
      const result = await this.reply.reply(dto.text, history, user);
      toolNames = result.toolCalls.map((c) => c.name);
      const partsInput = buildAssistantParts(result);
      assistantMessage = existing?.assistantMessage
        ? await this.prisma.message.update({
            where: { id: existing.assistantMessage.id },
            data: { status: MessageStatus.COMPLETED, requestId, parts: { deleteMany: {}, create: partsInput } },
            include: { parts: { orderBy: { order: 'asc' } } },
          })
        : await this.prisma.message.create({
            data: { conversationId, role: MessageRole.ASSISTANT, status: MessageStatus.COMPLETED, requestId, parts: { create: partsInput } },
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
            data: { status: MessageStatus.FAILED, requestId, parts: { deleteMany: {}, create: errorPart } },
            include: { parts: { orderBy: { order: 'asc' } } },
          })
        : await this.prisma.message.create({
            data: { conversationId, role: MessageRole.ASSISTANT, status: MessageStatus.FAILED, requestId, parts: { create: errorPart } },
            include: { parts: { orderBy: { order: 'asc' } } },
          });
    }

    await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });

    this.logger.log(
      `assistant chat reqId=${requestId} conversationId=${conversationId} status=${assistantMessage.status} ` +
        `toolsCalled=${toolNames.length ? toolNames.join(',') : 'none'} totalMs=${Date.now() - t0}`,
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
    const history = await this.loadHistory(conversationId);

    // В отличие от sendMessage, здесь сам объект пользовательского
    // сообщения стриминговым событиям не нужен (клиент уже показал его
    // оптимистично) — но персистить его всё равно нужно, если это не
    // повтор уже существующей пары.
    if (!existing?.userMessage) {
      await this.prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.USER,
          status: MessageStatus.COMPLETED,
          clientRequestId: dto.clientRequestId || null,
          parts: { create: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: dto.text } }] },
        },
      });
    }

    const assistantMessage =
      existing?.assistantMessage ??
      (await this.prisma.message.create({
        data: { conversationId, role: MessageRole.ASSISTANT, status: MessageStatus.STREAMING, requestId, parts: { create: [] } },
        include: { parts: { orderBy: { order: 'asc' } } },
      }));

    emit({ event: 'message.started', messageId: assistantMessage.id });
    emit({ event: 'part.started', messageId: assistantMessage.id, partId: ASSISTANT_TEXT_PART_ID });

    const toolNames: string[] = [];
    try {
      const result = await this.reply.streamReply(
        dto.text,
        history,
        user,
        (e) => {
          if (e.type === 'text-reset') {
            emit({ event: 'part.started', messageId: assistantMessage.id, partId: ASSISTANT_TEXT_PART_ID });
          } else if (e.type === 'text-delta') {
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
          `toolsCalled=${toolNames.length ? toolNames.join(',') : 'none'} streaming=true totalMs=${Date.now() - t0}`,
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
      this.logger.log(`assistant chat reqId=${requestId} conversationId=${conversationId} status=FAILED streaming=true totalMs=${Date.now() - t0}`);
    }
  }
}

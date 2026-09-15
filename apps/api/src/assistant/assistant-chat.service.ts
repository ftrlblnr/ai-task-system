import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Conversation, Message, MessagePart, MessageRole, MessageStatus, MessagePartType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantReplyService } from './assistant-reply.service';
import { SendMessageDto } from './dto/send-message.dto';

// Сколько предыдущих сообщений разговора отдавать модели как историю — тот
// же порядок величины, что VOICE_HISTORY_LIMIT в voice.service.ts, здесь не
// делится по времени (в отличие от voice): один Conversation — один
// логически непрерывный диалог, а не заметки, между которыми могло пройти
// много часов.
const HISTORY_LIMIT = 20;

export type MessageWithParts = Message & { parts: MessagePart[] };

// Stage 2, Phase B — только персист + один обычный (без tool use) ответ
// ассистента. Никакого доступа к Task/Event здесь нет — это Phase C.
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

  async getMessages(user: AuthenticatedUser, conversationId: string): Promise<MessageWithParts[]> {
    await this.findOwnedConversation(user, conversationId);
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      include: { parts: { orderBy: { order: 'asc' } } },
    });
  }

  async sendMessage(
    user: AuthenticatedUser,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<{ userMessage: MessageWithParts; assistantMessage: MessageWithParts }> {
    await this.findOwnedConversation(user, conversationId);

    // Идемпотентность (Stage 2 §29) — тот же clientRequestId в этом же
    // разговоре означает "это тот же самый запрос отправки", не новое
    // сообщение. Ищем по уникальной паре (conversationId, clientRequestId)
    // вместо повторной генерации ответа.
    if (dto.clientRequestId) {
      const existingUserMessage = await this.prisma.message.findUnique({
        where: { conversationId_clientRequestId: { conversationId, clientRequestId: dto.clientRequestId } },
        include: { parts: { orderBy: { order: 'asc' } } },
      });
      if (existingUserMessage) {
        const assistantMessage = await this.prisma.message.findFirst({
          where: { conversationId, role: MessageRole.ASSISTANT, createdAt: { gt: existingUserMessage.createdAt } },
          orderBy: { createdAt: 'asc' },
          include: { parts: { orderBy: { order: 'asc' } } },
        });
        // Если ассистентский ответ ещё не успел сохраниться (гонка
        // одновременных повторов) — по-прежнему не создаём вторую пару, а
        // просто нет второго сообщения в ответе; клиент увидит его при
        // следующем GET /messages.
        if (assistantMessage) {
          return { userMessage: existingUserMessage, assistantMessage };
        }
      }
    }

    const requestId = randomUUID();
    const t0 = Date.now();

    const history = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      include: { parts: { where: { type: MessagePartType.MARKDOWN }, orderBy: { order: 'asc' }, take: 1 } },
    });

    const userMessage = await this.prisma.message.create({
      data: {
        conversationId,
        role: MessageRole.USER,
        status: MessageStatus.COMPLETED,
        clientRequestId: dto.clientRequestId || null,
        parts: { create: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: dto.text } }] },
      },
      include: { parts: { orderBy: { order: 'asc' } } },
    });

    let assistantMessage: MessageWithParts;
    try {
      const replyText = await this.reply.reply(
        dto.text,
        history
          .reverse()
          .map((m) => ({
            role: m.role === MessageRole.USER ? ('user' as const) : ('assistant' as const),
            text: (m.parts[0]?.data as { content?: string } | undefined)?.content ?? '',
          }))
          .filter((h) => h.text),
      );
      assistantMessage = await this.prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.ASSISTANT,
          status: MessageStatus.COMPLETED,
          requestId,
          parts: { create: [{ type: MessagePartType.MARKDOWN, order: 0, data: { content: replyText } }] },
        },
        include: { parts: { orderBy: { order: 'asc' } } },
      });
    } catch (err) {
      // Техническая ошибка — только в логи (Stage 2 §5.6/§32); пользователю
      // уходит безопасный текст через ErrorPart.
      this.logger.error(`assistant reply reqId=${requestId} failed: ${err instanceof Error ? err.message : err}`);
      assistantMessage = await this.prisma.message.create({
        data: {
          conversationId,
          role: MessageRole.ASSISTANT,
          status: MessageStatus.FAILED,
          requestId,
          parts: { create: [{ type: MessagePartType.ERROR, order: 0, data: { message: 'Не удалось получить ответ ассистента. Попробуйте ещё раз.' } }] },
        },
        include: { parts: { orderBy: { order: 'asc' } } },
      });
    }

    await this.prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });

    this.logger.log(
      `assistant chat reqId=${requestId} conversationId=${conversationId} status=${assistantMessage.status} totalMs=${Date.now() - t0}`,
    );

    return { userMessage, assistantMessage };
  }
}

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { MessageRole, type MessagePart } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiUsageService, errorText, trackedCreate } from '../ai-usage/ai-usage.service';
import { loadMailCardState, type MailCardState } from './assistant-mail-state';
import { buildCompactionSystem, buildCompactionUser, clampSummary, selectMessagesToCompact } from './conversation-summary';

// Сериализатор сообщений для модели передаёт AssistantChatService (тот же,
// что для истории) — без импорта сервиса чата отсюда и цикла модулей.
export type MessageSerializer = (parts: MessagePart[], mailState?: MailCardState) => string;

const MODEL = 'claude-haiku-5-5';

// Сжатие истории разговора (ARMS, фаза 1.2) — после ответа, в фоне.
// Состояние целиком в Conversation (summary/summaryUpToAt): упавшее сжатие
// просто повторится после следующего сообщения, отдельная очередь не нужна.
// Запись — условная (summaryUpToAt не сдвинулся), поэтому два процесса не
// затрут сводку друг друга.
@Injectable()
export class ConversationCompactionService {
  private readonly logger = new Logger(ConversationCompactionService.name);
  private client: Anthropic | null = null;
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    return this.client;
  }

  // Не бросает: фоновая работа после уже отданного ответа.
  async maybeCompact(conversationId: string, historyLimit: number, serialize: MessageSerializer): Promise<boolean> {
    if (this.inFlight.has(conversationId)) return false;
    this.inFlight.add(conversationId);
    try {
      return await this.compact(conversationId, historyLimit, serialize);
    } catch (err) {
      this.logger.warn(`compaction conversation=${conversationId} failed: ${errorText(err)}`);
      return false;
    } finally {
      this.inFlight.delete(conversationId);
    }
  }

  private async compact(conversationId: string, historyLimit: number, serialize: MessageSerializer): Promise<boolean> {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId }, select: { summary: true, summaryUpToAt: true } });
    if (!conversation) return false;
    const unsummarized = await this.prisma.message.findMany({
      where: { conversationId, ...(conversation.summaryUpToAt ? { createdAt: { gt: conversation.summaryUpToAt } } : {}) },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true },
    });
    const batch = selectMessagesToCompact(unsummarized, historyLimit);
    if (batch.length === 0) return false;

    const messages = await this.prisma.message.findMany({
      where: { id: { in: batch.map((m) => m.id) } },
      orderBy: { createdAt: 'asc' },
      include: { parts: { orderBy: { order: 'asc' } } },
    });
    const mailState = await loadMailCardState(this.prisma, messages.flatMap((m) => m.parts));
    const input = messages
      .map((m) => ({ role: m.role === MessageRole.USER ? ('user' as const) : ('assistant' as const), text: serialize(m.parts, mailState), createdAt: m.createdAt }))
      .filter((m) => m.text.trim());

    const response = await trackedCreate(this.aiUsage, 'conversation.compact', this.getClient(), {
      model: MODEL,
      max_tokens: 2048,
      output_config: { effort: 'low' },
      system: buildCompactionSystem(),
      messages: [{ role: 'user', content: buildCompactionUser(conversation.summary, input) }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) return false;

    const upTo = batch[batch.length - 1].createdAt;
    const updated = await this.prisma.conversation.updateMany({
      where: { id: conversationId, summaryUpToAt: conversation.summaryUpToAt },
      data: { summary: clampSummary(text), summaryUpToAt: upTo, summaryUpdatedAt: new Date() },
    });
    return updated.count === 1;
  }
}

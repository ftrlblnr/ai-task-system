import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import {
  AssistantChatService,
  type InternalStreamEvent,
} from './assistant-chat.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { RenameConversationDto } from './dto/rename-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { VoiceUndoDto } from '../voice/dto/voice-undo.dto';
import { UndoService } from './undo.service';
import type { StreamEvent } from './dto/stream-event.dto';
import {
  toResponseConversation,
  toResponseMessage,
  toResponseMessagePart,
} from './assistant-response.mapper';

// Пинг SSE-потока ответа — см. streamMessage.
const SSE_KEEPALIVE_MS = 15_000;

// Без @Roles(...) — как VoiceController/TasksController: чат ассистента
// доступен любому сотруднику, не только OWNER (владение конкретным
// Conversation проверяется в сервисе, не ролью).
//
// toResponseConversation/toResponseMessage/toResponseMessagePart —
// публичный HTTP-контракт (packages/shared-types) объявляет role/status/
// type строчными строками, AssistantChatService работает с внутренним
// Prisma-представлением (заглавные enum'ы) — маппинг применяется здесь,
// на границе, а не в сервисе (см. assistant-response.mapper.ts).
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assistant')
export class AssistantChatController {
  constructor(
    private readonly chat: AssistantChatService,
    private readonly undoService: UndoService,
  ) {}

  // Единый агент A4: «Отменить» на карточке, которую оставил ассистент
  // (текст, голос, живой голос) — только непрозрачный токен, откат по
  // серверному снимку. POST /voice/undo — тот же метод для прежних клиентов.
  @Post('undo')
  undo(@Body() dto: VoiceUndoDto, @CurrentUser() user: AuthenticatedUser) {
    return this.undoService.undo(dto, user);
  }

  @Get('conversations')
  async listConversations(@CurrentUser() user: AuthenticatedUser) {
    const conversations = await this.chat.listConversations(user);
    return conversations.map(toResponseConversation);
  }

  @Post('conversations')
  async createConversation(
    @Body() dto: CreateConversationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return toResponseConversation(
      await this.chat.createConversation(user, dto.title),
    );
  }

  @Patch('conversations/:id')
  async renameConversation(
    @Param('id') id: string,
    @Body() dto: RenameConversationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return toResponseConversation(
      await this.chat.renameConversation(user, id, dto.title),
    );
  }

  @Get('conversations/:id/messages')
  async getMessages(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const messages = await this.chat.getMessages(user, id);
    return messages.map(toResponseMessage);
  }

  @Post('conversations/:id/messages')
  async sendMessage(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { userMessage, assistantMessage } = await this.chat.sendMessage(
      user,
      id,
      dto,
    );
    return {
      userMessage: toResponseMessage(userMessage),
      assistantMessage: toResponseMessage(assistantMessage),
    };
  }

  // Stage 2, Phase E — тот же запрос, что sendMessage, но ответ —
  // text/event-stream (спека §13/§14): прогресс приходит по мере
  // готовности, не одним блокирующим JSON-ответом. Владение разговором
  // проверяется ДО открытия потока (assertOwnedConversation) — иначе 404
  // на чужой conversationId потерялся бы внутри уже открытого SSE-потока
  // вместо обычного JSON-ответа с кодом ошибки. assertAttachmentsAvailable
  // (Phase F.2, аудит 17.09.2026, P2.11) — та же причина: 400 на
  // недоступное вложение должен прийти обычным JSON-ответом, а не
  // потеряться внутри уже открытого потока.
  @Post('conversations/:id/messages/stream')
  async streamMessage(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ): Promise<void> {
    await this.chat.assertOwnedConversation(user, id);
    await this.chat.assertAttachmentsAvailable(user, dto.attachmentIds);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Двойная защита от буферизации прод-nginx (см. infra/nginx —
    // proxy_buffering off) — без обоих SSE пришёл бы одним куском в конце.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const emit = (event: InternalStreamEvent) => {
      res.write(
        `event: ${event.event}\ndata: ${JSON.stringify(toWireEvent(event))}\n\n`,
      );
    };

    // Обрыв соединения клиентом — не продолжаем платить за токены Anthropic,
    // которые уже некому показать (спека §34-E, "reconnect handling").
    const abortController = new AbortController();
    res.on('close', () => abortController.abort());

    // Пока работает долгий инструмент (агент-юрист — 1–2 минуты), в поток
    // ничего не пишется, а nginx рвёт соединение после 60 с тишины
    // (proxy_read_timeout). SSE-комментарий клиенты пропускают: кадр без
    // строки data: (web assistant/page.tsx, miniapp assistant-screen.tsx).
    const keepAlive = setInterval(
      () => res.write(': ping\n\n'),
      SSE_KEEPALIVE_MS,
    );

    try {
      await this.chat.streamMessage(
        user,
        id,
        dto,
        emit,
        abortController.signal,
      );
    } finally {
      clearInterval(keepAlive);
      res.end();
    }
  }
}

function toWireEvent(event: InternalStreamEvent): StreamEvent {
  switch (event.event) {
    case 'message.started':
      return {
        event: 'message.started',
        messageId: event.messageId,
        userMessage: toResponseMessage(event.userMessage),
      };
    case 'part.completed':
      return {
        event: 'part.completed',
        messageId: event.messageId,
        partId: event.partId,
        part: toResponseMessagePart(event.part),
      };
    case 'message.completed':
      return {
        event: 'message.completed',
        messageId: event.messageId,
        message: toResponseMessage(event.message),
      };
    default:
      return event;
  }
}

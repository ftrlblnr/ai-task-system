import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantChatService } from './assistant-chat.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { toResponseConversation, toResponseMessage } from './assistant-response.mapper';

// Без @Roles(...) — как VoiceController/TasksController: чат ассистента
// доступен любому сотруднику, не только OWNER (владение конкретным
// Conversation проверяется в сервисе, не ролью).
//
// toResponseConversation/toResponseMessage — публичный HTTP-контракт
// (packages/shared-types) объявляет role/status/type строчными строками,
// AssistantChatService работает с внутренним Prisma-представлением
// (заглавные enum'ы) — маппинг применяется здесь, на границе, а не в
// сервисе (см. assistant-response.mapper.ts).
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assistant')
export class AssistantChatController {
  constructor(private readonly chat: AssistantChatService) {}

  @Get('conversations')
  async listConversations(@CurrentUser() user: AuthenticatedUser) {
    const conversations = await this.chat.listConversations(user);
    return conversations.map(toResponseConversation);
  }

  @Post('conversations')
  async createConversation(@Body() dto: CreateConversationDto, @CurrentUser() user: AuthenticatedUser) {
    return toResponseConversation(await this.chat.createConversation(user, dto.title));
  }

  @Get('conversations/:id/messages')
  async getMessages(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const messages = await this.chat.getMessages(user, id);
    return messages.map(toResponseMessage);
  }

  @Post('conversations/:id/messages')
  async sendMessage(@Param('id') id: string, @Body() dto: SendMessageDto, @CurrentUser() user: AuthenticatedUser) {
    const { userMessage, assistantMessage } = await this.chat.sendMessage(user, id, dto);
    return { userMessage: toResponseMessage(userMessage), assistantMessage: toResponseMessage(assistantMessage) };
  }
}

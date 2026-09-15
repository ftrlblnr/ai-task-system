import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantChatService } from './assistant-chat.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';

// Без @Roles(...) — как VoiceController/TasksController: чат ассистента
// доступен любому сотруднику, не только OWNER (владение конкретным
// Conversation проверяется в сервисе, не ролью).
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assistant')
export class AssistantChatController {
  constructor(private readonly chat: AssistantChatService) {}

  @Get('conversations')
  listConversations(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.listConversations(user);
  }

  @Post('conversations')
  createConversation(@Body() dto: CreateConversationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.chat.createConversation(user, dto.title);
  }

  @Get('conversations/:id/messages')
  getMessages(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.chat.getMessages(user, id);
  }

  @Post('conversations/:id/messages')
  sendMessage(@Param('id') id: string, @Body() dto: SendMessageDto, @CurrentUser() user: AuthenticatedUser) {
    return this.chat.sendMessage(user, id, dto);
  }
}

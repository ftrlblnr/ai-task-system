import { Module } from '@nestjs/common';
import { AssistantChatController } from './assistant-chat.controller';
import { AssistantChatService } from './assistant-chat.service';
import { AssistantReplyService } from './assistant-reply.service';

@Module({
  controllers: [AssistantChatController],
  providers: [AssistantChatService, AssistantReplyService],
})
export class AssistantModule {}

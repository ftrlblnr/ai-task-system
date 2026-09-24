import { Module } from '@nestjs/common';
import { AssistantModule } from '../assistant/assistant.module';
import { LiveController } from './live.controller';
import { LiveService } from './live.service';

// AssistantModule экспортирует AssistantChatService — делегированные задачи
// GPT-Live выполняются как обычные сообщения чата (см. LiveService).
@Module({
  imports: [AssistantModule],
  controllers: [LiveController],
  providers: [LiveService],
})
export class LiveModule {}

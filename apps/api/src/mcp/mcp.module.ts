import { Module } from '@nestjs/common';
import { AssistantModule } from '../assistant/assistant.module';
import { McpController } from './mcp.controller';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

// Подключение внешних ИИ (Claude) по MCP + OAuth, владелец 22.10.2026.
@Module({
  imports: [AssistantModule],
  controllers: [McpController, OAuthController],
  providers: [OAuthService],
})
export class McpModule {}

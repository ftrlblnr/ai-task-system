import { Module } from '@nestjs/common';
import { AssistantModule } from '../assistant/assistant.module';
import { VoiceModule } from '../voice/voice.module';
import { LiveController } from './live.controller';
import { LiveService } from './live.service';

// AssistantModule — владение разговором/история для session.input;
// VoiceModule — делегации GPT-Live исполняются голосовым пайплайном без STT
// (VoiceService.parseTranscript, см. LiveService).
@Module({
  imports: [AssistantModule, VoiceModule],
  controllers: [LiveController],
  providers: [LiveService],
})
export class LiveModule {}

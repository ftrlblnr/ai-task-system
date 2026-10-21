import { Global, Module } from '@nestjs/common';
import { AiUsageService } from './ai-usage.service';

@Global()
@Module({
  providers: [AiUsageService],
  exports: [AiUsageService],
})
export class AiUsageModule {}

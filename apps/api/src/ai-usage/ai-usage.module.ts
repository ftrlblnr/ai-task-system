import { Global, Module } from '@nestjs/common';
import { AiUsageController } from './ai-usage.controller';
import { AiUsageService } from './ai-usage.service';

@Global()
@Module({
  controllers: [AiUsageController],
  providers: [AiUsageService],
  exports: [AiUsageService],
})
export class AiUsageModule {}

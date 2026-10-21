import { Module } from '@nestjs/common';
import { NpaSearchService } from './npa-search.service';
import { LegalAgentService } from './legal-agent.service';
import { LegalController } from './legal.controller';

// Агент-юрист (ТЗ handoff 21.10.2026): база НПА, поиск, юр-агент.
@Module({
  controllers: [LegalController],
  providers: [NpaSearchService, LegalAgentService],
  exports: [NpaSearchService, LegalAgentService],
})
export class LegalModule {}

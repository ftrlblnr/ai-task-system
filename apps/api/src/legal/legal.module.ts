import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { NpaSearchService } from './npa-search.service';
import { LegalAgentService } from './legal-agent.service';
import { LegalController } from './legal.controller';
import { LegalReviewService } from './legal-review.service';
import { LegalReviewExecutionService } from './legal-review-execution.service';

// Агент-юрист (ТЗ handoff 21.10.2026): база НПА, поиск, юр-агент, разбор
// договоров (фоновый воркер).
@Module({
  imports: [FilesModule],
  controllers: [LegalController],
  providers: [NpaSearchService, LegalAgentService, LegalReviewService, LegalReviewExecutionService],
  exports: [NpaSearchService, LegalAgentService, LegalReviewService],
})
export class LegalModule {}

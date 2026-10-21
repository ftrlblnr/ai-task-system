import { Module } from '@nestjs/common';
import { NpaSearchService } from './npa-search.service';

// Агент-юрист (ТЗ handoff 21.10.2026). Этап 1 — база НПА и поиск по ней.
@Module({
  providers: [NpaSearchService],
  exports: [NpaSearchService],
})
export class LegalModule {}

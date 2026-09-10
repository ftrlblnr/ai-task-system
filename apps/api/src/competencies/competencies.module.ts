import { Module } from '@nestjs/common';
import { CompetenciesController } from './competencies.controller';
import { CompetenciesService } from './competencies.service';

@Module({
  controllers: [CompetenciesController],
  providers: [CompetenciesService],
  exports: [CompetenciesService],
})
export class CompetenciesModule {}

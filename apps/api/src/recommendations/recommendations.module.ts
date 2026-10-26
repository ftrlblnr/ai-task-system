import { Module } from '@nestjs/common';
import { MemoryModule } from '../memory/memory.module';
import { RoutinesModule } from '../routines/routines.module';
import { SkillsModule } from '../skills/skills.module';
import { TasksModule } from '../tasks/tasks.module';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';
import { RecommendationGenerationService } from './recommendation-generation.service';

// ARMS, фаза 5 — рекомендации: еженедельный анализ и применение кнопкой.
@Module({
  imports: [MemoryModule, RoutinesModule, SkillsModule, TasksModule],
  controllers: [RecommendationsController],
  providers: [RecommendationsService, RecommendationGenerationService],
  exports: [RecommendationsService],
})
export class RecommendationsModule {}

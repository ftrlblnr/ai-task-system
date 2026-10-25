import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';
import { SkillRevisionService } from './skill-revision.service';

// ARMS, фаза 3 — навыки. Запуск навыка кнопкой исполняет
// SkillRunExecutionService в AssistantModule (ему нужен чат ассистента);
// здесь — данные навыков, отзывы и генерация предложений правок.
@Module({
  imports: [FilesModule],
  controllers: [SkillsController],
  providers: [SkillsService, SkillRevisionService],
  exports: [SkillsService],
})
export class SkillsModule {}

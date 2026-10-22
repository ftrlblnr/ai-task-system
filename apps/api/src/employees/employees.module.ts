import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { MeController } from './me.controller';
import { AvatarsController } from './avatars.controller';
import { AvatarService } from './avatar.service';
import { EmployeesService } from './employees.service';
import { EmployeeResolverService } from './employee-resolver.service';
import { CompanyVocabularyService } from './company-vocabulary.service';

@Module({
  controllers: [EmployeesController, MeController, AvatarsController],
  providers: [AvatarService, EmployeesService, EmployeeResolverService, CompanyVocabularyService],
  exports: [EmployeesService, EmployeeResolverService, CompanyVocabularyService],
})
export class EmployeesModule {}

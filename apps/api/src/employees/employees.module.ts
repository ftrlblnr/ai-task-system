import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { MeController } from './me.controller';
import { EmployeesService } from './employees.service';
import { EmployeeResolverService } from './employee-resolver.service';
import { CompanyVocabularyService } from './company-vocabulary.service';

@Module({
  controllers: [EmployeesController, MeController],
  providers: [EmployeesService, EmployeeResolverService, CompanyVocabularyService],
  exports: [EmployeesService, EmployeeResolverService, CompanyVocabularyService],
})
export class EmployeesModule {}

import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { MeController } from './me.controller';
import { EmployeesService } from './employees.service';

@Module({
  controllers: [EmployeesController, MeController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}

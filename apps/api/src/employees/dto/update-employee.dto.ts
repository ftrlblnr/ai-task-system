import { PartialType, OmitType } from '@nestjs/mapped-types';
import { IsEnum, IsOptional } from 'class-validator';
import { EmployeeStatus } from '@prisma/client';
import { CreateEmployeeDto } from './create-employee.dto';

export class UpdateEmployeeDto extends PartialType(
  OmitType(CreateEmployeeDto, ['password'] as const),
) {
  // Отключение учётки вместо удаления (владелец 09.11.2026): задачи,
  // комментарии и история остаются, вход закрыт.
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;
}

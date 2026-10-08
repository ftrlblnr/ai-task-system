import { IsDateString, IsString } from 'class-validator';

// Раздел 10 ТЗ — assigneeId и dueDate обязательны на этом уровне (не
// IsOptional, в отличие от общего CreateTaskDto): "никогда не изобретая
// отсутствующие параметры" означает именно это — без обоих полей запрос
// отклоняется ValidationPipe'ом раньше, чем дойдёт до сервиса.
export class ProposeTripTaskDto {
  @IsString()
  title: string;

  @IsString()
  assigneeId: string;

  @IsDateString()
  dueDate: string;
}

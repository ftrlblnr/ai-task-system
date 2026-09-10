import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { EventStatus } from '@prisma/client';

export class CreateEventDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsDateString()
  startAt: string;

  @IsDateString()
  endAt: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  // DRAFT — например, черновик от голосового AI-агента, ждёт подтверждения
  // руководителя и не синхронизируется в Google, пока не станет CONFIRMED.
  @IsOptional()
  @IsEnum(EventStatus)
  status?: EventStatus;
}

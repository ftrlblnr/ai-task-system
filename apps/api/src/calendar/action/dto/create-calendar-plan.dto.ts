import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

const CALENDAR_ACTION_TYPES = ['CREATE_EVENT', 'UPDATE_EVENT', 'RESCHEDULE_EVENT', 'CANCEL_EVENT'] as const;

export class CalendarActionCandidateDto {
  @IsString()
  localId!: string;

  @IsIn(CALENDAR_ACTION_TYPES)
  type!: (typeof CALENDAR_ACTION_TYPES)[number];

  @IsOptional()
  @IsString()
  targetEventId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  beforeVersion?: number;

  @IsObject()
  parameters!: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependsOnLocalIds?: string[];
}

// Раздел 7/20 ТЗ — создание плана с уже решёнными действиями (разбор
// поручения на структурированные команды делает вызывающий tool
// ассистента, не этот endpoint — раздел 23 ТЗ: "Результат валидируется
// JSON Schema/DTO; неизвестные действия/поля отклоняются").
export class CreateCalendarPlanDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  requestText!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CalendarActionCandidateDto)
  actions?: CalendarActionCandidateDto[];
}

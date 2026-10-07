import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, Min, ValidateNested } from 'class-validator';

export class WorkingHoursRuleDto {
  @IsInt()
  @Min(0)
  weekday!: number;

  @IsInt()
  @Min(0)
  startMinute!: number;

  @IsInt()
  @Min(0)
  endMinute!: number;
}

// Раздел 22 ТЗ календарного агента — PATCH /calendar/policy с
// expectedVersion. version необязателен здесь по той же причине, что в
// UpdateEventDto: первое сохранение политики (её ещё не существует) не
// может передать версию несуществующей записи.
export class UpdateCalendarPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsOptional()
  @IsInt()
  timeZoneOffsetMinutes?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkingHoursRuleDto)
  workingHours?: WorkingHoursRuleDto[];

  @IsOptional()
  @IsInt()
  @Min(0)
  bufferMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  minNoticeHours?: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  slotStepMinutes?: number;
}

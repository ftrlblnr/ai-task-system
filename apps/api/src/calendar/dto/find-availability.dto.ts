import { IsDateString, IsIn, IsOptional } from 'class-validator';

// Раздел 22 ТЗ — POST /calendar/availability. durationMinutes ограничен
// тем же набором, что раздел 11 ТЗ предлагает по умолчанию (15/30/60) —
// проектное значение, не ограничение Google.
export class FindAvailabilityDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  @IsIn([15, 30, 60])
  durationMinutes!: number;

  @IsOptional()
  @IsIn([1, 2, 3, 4, 5])
  maxResults?: number;
}

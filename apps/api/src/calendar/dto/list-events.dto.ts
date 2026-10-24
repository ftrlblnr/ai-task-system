import { IsDateString, IsOptional } from 'class-validator';

// GET /events?from&to (редизайн Mini App M3, 24.10.2026) — неделя календаря:
// события, пересекающие диапазон. Без параметров — все события, как раньше
// (web /calendar грузит список целиком).
export class ListEventsDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

import { IsInt, IsOptional, IsString } from 'class-validator';

export class UpdateTripEventDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  startAt?: string | null;

  @IsOptional()
  @IsInt()
  startTimeZoneOffsetMinutes?: number | null;

  @IsOptional()
  @IsString()
  dateOnly?: string | null;

  @IsOptional()
  @IsString()
  endAt?: string | null;

  @IsOptional()
  @IsString()
  location?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

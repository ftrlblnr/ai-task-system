import { IsInt, IsOptional, IsString } from 'class-validator';

export class CreateTripEventDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  startAt?: string;

  @IsOptional()
  @IsInt()
  startTimeZoneOffsetMinutes?: number;

  @IsOptional()
  @IsString()
  dateOnly?: string;

  @IsOptional()
  @IsString()
  endAt?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

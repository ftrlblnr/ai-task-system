import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { TripBookingStatus, TripLegMode } from '@prisma/client';

export class UpdateTripLegDto {
  @IsOptional()
  @IsEnum(TripLegMode)
  mode?: TripLegMode;

  @IsOptional()
  @IsString()
  fromLocation?: string | null;

  @IsOptional()
  @IsString()
  toLocation?: string | null;

  @IsOptional()
  @IsString()
  departAt?: string | null;

  @IsOptional()
  @IsInt()
  departTimeZoneOffsetMinutes?: number | null;

  @IsOptional()
  @IsString()
  arriveAt?: string | null;

  @IsOptional()
  @IsInt()
  arriveTimeZoneOffsetMinutes?: number | null;

  @IsOptional()
  @IsString()
  carrier?: string | null;

  @IsOptional()
  @IsString()
  referenceCode?: string | null;

  @IsOptional()
  @IsEnum(TripBookingStatus)
  bookingStatus?: TripBookingStatus;
}

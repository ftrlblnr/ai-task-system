import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';
import { TripBookingStatus, TripLegMode } from '@prisma/client';

export class CreateTripLegDto {
  @IsEnum(TripLegMode)
  mode: TripLegMode;

  @IsOptional()
  @IsString()
  fromLocation?: string;

  @IsOptional()
  @IsString()
  toLocation?: string;

  @IsOptional()
  @IsString()
  departAt?: string;

  @IsOptional()
  @IsInt()
  departTimeZoneOffsetMinutes?: number;

  @IsOptional()
  @IsString()
  arriveAt?: string;

  @IsOptional()
  @IsInt()
  arriveTimeZoneOffsetMinutes?: number;

  @IsOptional()
  @IsString()
  carrier?: string;

  @IsOptional()
  @IsString()
  referenceCode?: string;

  @IsEnum(TripBookingStatus)
  bookingStatus: TripBookingStatus;
}

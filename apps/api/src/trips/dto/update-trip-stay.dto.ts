import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TripBookingStatus } from '@prisma/client';

export class UpdateTripStayDto {
  @IsOptional()
  @IsString()
  name?: string | null;

  @IsOptional()
  @IsString()
  address?: string | null;

  @IsOptional()
  @IsString()
  checkInAt?: string | null;

  @IsOptional()
  @IsString()
  checkOutAt?: string | null;

  @IsOptional()
  @IsEnum(TripBookingStatus)
  bookingStatus?: TripBookingStatus;
}

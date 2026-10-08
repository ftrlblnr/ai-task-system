import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TripBookingStatus } from '@prisma/client';

export class CreateTripStayDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  checkInAt?: string;

  @IsOptional()
  @IsString()
  checkOutAt?: string;

  @IsEnum(TripBookingStatus)
  bookingStatus: TripBookingStatus;
}

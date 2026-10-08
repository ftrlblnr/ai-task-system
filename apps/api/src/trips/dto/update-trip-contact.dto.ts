import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TripContactRole } from '@prisma/client';

export class UpdateTripContactDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(TripContactRole)
  role?: TripContactRole;

  @IsOptional()
  @IsString()
  organization?: string | null;

  @IsOptional()
  @IsString()
  email?: string | null;

  @IsOptional()
  @IsString()
  phone?: string | null;
}

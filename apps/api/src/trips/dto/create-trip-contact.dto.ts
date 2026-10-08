import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TripContactRole } from '@prisma/client';

export class CreateTripContactDto {
  @IsString()
  name: string;

  @IsEnum(TripContactRole)
  role: TripContactRole;

  @IsOptional()
  @IsString()
  organization?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

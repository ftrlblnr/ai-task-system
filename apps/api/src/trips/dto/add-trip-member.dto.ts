import { IsEnum, IsString } from 'class-validator';
import { TripAccessRole } from '@prisma/client';

export class AddTripMemberDto {
  @IsString()
  employeeId: string;

  @IsEnum(TripAccessRole)
  accessRole: TripAccessRole;
}

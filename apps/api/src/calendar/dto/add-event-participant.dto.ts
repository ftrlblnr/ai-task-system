import { IsString } from 'class-validator';

export class AddEventParticipantDto {
  @IsString()
  employeeId: string;
}

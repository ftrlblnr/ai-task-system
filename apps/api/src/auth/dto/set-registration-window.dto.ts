import { IsBoolean } from 'class-validator';

export class SetRegistrationWindowDto {
  @IsBoolean()
  isOpen: boolean;
}

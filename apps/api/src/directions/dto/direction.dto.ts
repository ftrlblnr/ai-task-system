import { IsString } from 'class-validator';

export class CreateDirectionDto {
  @IsString()
  title: string;
}

import { IsString } from 'class-validator';

export class CreatePositionDto {
  @IsString()
  title: string;
}

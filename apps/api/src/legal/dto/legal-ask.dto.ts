import { IsString, MaxLength, MinLength } from 'class-validator';

export class LegalAskDto {
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  question!: string;
}

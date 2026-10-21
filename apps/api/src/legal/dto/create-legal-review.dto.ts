import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateLegalReviewDto {
  @IsString()
  @MinLength(1)
  fileId!: string;

  // «На что обратить внимание» — от юриста, попадает в промпт агента.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  focus?: string;
}

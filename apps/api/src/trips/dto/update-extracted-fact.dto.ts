import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ExtractedFactStatus } from '@prisma/client';

export class UpdateExtractedFactDto {
  @IsOptional()
  @IsString()
  factKey?: string;

  @IsOptional()
  @IsString()
  factValue?: string;

  @IsOptional()
  @IsEnum(ExtractedFactStatus)
  status?: ExtractedFactStatus;
}

import { IsOptional, IsString } from 'class-validator';

export class UpdateTripDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  purposeSummary?: string | null;

  @IsOptional()
  @IsString()
  cancelledAt?: string | null;
}

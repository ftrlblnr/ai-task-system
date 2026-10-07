import { IsInt, IsObject, IsOptional, Min } from 'class-validator';

export class PatchCalendarActionDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}

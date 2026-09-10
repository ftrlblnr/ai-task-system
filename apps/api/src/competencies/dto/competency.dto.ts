import { IsString, MinLength } from 'class-validator';

export class CompetencyDto {
  @IsString()
  name: string;

  // Раздел 6.4 ТЗ: развёрнутое описание, а не короткий тег — точность
  // классификации задач напрямую от этого зависит.
  @IsString()
  @MinLength(20)
  description: string;
}

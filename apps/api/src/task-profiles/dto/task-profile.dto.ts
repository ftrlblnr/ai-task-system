import { ArrayNotEmpty, IsArray, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateTaskProfileDto {
  @IsString()
  category: string;

  @IsString()
  type: string;

  // Развёрнутое описание (раздел 6.4 ТЗ) — по нему AI сначала классифицирует
  // задачу, и только потом ищет исполнителя.
  @IsString()
  @MinLength(20)
  description: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  requiredCompetencyIds?: string[];
}

export class UpdateTaskProfileDto {
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requiredCompetencyIds?: string[];
}

import { IsOptional, IsString } from 'class-validator';

export class SetCompetencyDto {
  @IsString()
  competencyId: string;

  // Развёрнутое описание уровня/контекста владения (раздел 6.4 ТЗ) —
  // не просто факт "умеет", а что именно и в каком объёме.
  @IsOptional()
  @IsString()
  description?: string;
}

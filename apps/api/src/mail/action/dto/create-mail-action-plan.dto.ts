import { IsArray, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Раздел 4 ТЗ — охват плана: ящик уже известен (текущий пользователь), здесь
// только то, что сужает/направляет анализ. folderPaths/since/until —
// опциональные подсказки, requestText — свободный текст намерения
// ("разложи рассылки за последний месяц"), читает его этап анализа (#123).
export class CreateMailActionPlanDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  requestText!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  folderPaths?: string[];

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsISO8601()
  until?: string;
}

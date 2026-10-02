import { IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class CompleteReceptionRequestDto {
  @IsInt()
  @IsPositive()
  version: number;

  // Необязателен (раздел 9.3 ТЗ — сохранение без результата разрешено).
  @IsOptional()
  @IsString()
  @MaxLength(3000)
  resolution?: string;
}

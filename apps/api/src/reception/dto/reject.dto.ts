import { IsInt, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class RejectReceptionRequestDto {
  @IsInt()
  @IsPositive()
  version: number;

  // Необязательна (раздел 9.2 ТЗ — подтверждение с пустым полем разрешено).
  // Пустая строка после trim хранится как null (раздел 5 ТЗ) — сервис сам
  // приводит '' → null, здесь только потолок длины.
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

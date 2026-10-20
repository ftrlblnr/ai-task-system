import { IsInt, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

// Владелец 20.10.2026 — ответ руководителя без встречи. Голосовой ответ
// приходит сюда уже текстом: запись распознаётся отдельно (POST
// /reception/transcribe), руководитель правит текст и отправляет.
export class AnswerReceptionRequestDto {
  @IsInt()
  @IsPositive()
  version: number;

  @IsString()
  @MinLength(1)
  @MaxLength(3000)
  text: string;
}

// «Разберитесь сами» — комментарий необязателен.
export class DelegateReceptionRequestDto {
  @IsInt()
  @IsPositive()
  version: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

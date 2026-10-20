import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsPositive, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

// «Ответить и поставить задачу» (владелец 20.10.2026) — задача ставится в
// той же транзакции, что и ответ. Исполнитель по умолчанию — автор вопроса.
export class AnswerTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title: string;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

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

  @IsOptional()
  @ValidateNested()
  @Type(() => AnswerTaskDto)
  task?: AnswerTaskDto;
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

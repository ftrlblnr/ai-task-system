import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { ConfidenceLevel, TaskPriority } from '@prisma/client';

export class CreateTaskDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  taskProfileId?: string;

  @IsOptional()
  @IsString()
  assigneeId?: string;

  // Подзадача — обычная задача с parentTaskId (владелец 08.09.2026, по
  // образцу Linear/Asana). Один уровень вложенности проверяется в сервисе.
  @IsOptional()
  @IsString()
  parentTaskId?: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  // Раздел 9 ТЗ: источник задачи — встреча + точный таймкод. При ручной
  // постановке (не из встречи) sourceMeetingId не задаётся, а sourceContext
  // используется как обычная заметка руководителя.
  @IsOptional()
  @IsString()
  sourceMeetingId?: string;

  @IsOptional()
  @IsString()
  sourceTimestamp?: string;

  @IsOptional()
  @IsString()
  sourceContext?: string;

  // Заполняется при постановке задач из саммари встречи (владелец
  // 09.09.2026) — уверенность Claude в этом черновике (исполнитель/срок).
  // При обычном ручном создании не передаётся.
  @IsOptional()
  @IsEnum(ConfidenceLevel)
  aiConfidence?: ConfidenceLevel;
}

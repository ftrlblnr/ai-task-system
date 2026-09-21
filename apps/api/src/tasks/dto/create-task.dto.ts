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

  // assigneeId/priority/dueDate допускают null помимо undefined (владелец
  // 08.09.2026, см. TasksService.update) — undefined значит "поле не
  // пришло, не трогать", null значит "явно снять" (например, откат
  // голосового действия, VoiceService.undo, к состоянию "было не
  // назначено"). @IsOptional() у class-validator пропускает валидацию и
  // для null, и для undefined — типы здесь просто честно отражают то, что
  // сервис уже поддерживает.
  @IsOptional()
  @IsString()
  assigneeId?: string | null;

  // Подзадача — обычная задача с parentTaskId (владелец 08.09.2026, по
  // образцу Linear/Asana). Один уровень вложенности проверяется в сервисе.
  @IsOptional()
  @IsString()
  parentTaskId?: string;

  // priority — не null, в отличие от assigneeId/dueDate: в схеме
  // (Task.priority @default(MEDIUM)) поле обязательное, "снять приоритет"
  // не бывает — только конкретное значение или "не трогать" (undefined).
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

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

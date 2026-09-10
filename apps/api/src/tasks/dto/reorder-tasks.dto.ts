import { ArrayMinSize, IsArray, IsString } from 'class-validator';

// Полный новый порядок ОДНОЙ колонки канбана (все id одного статуса, в
// новой последовательности) — не пара соседей: так реордер устойчив к
// коллизиям, когда у нескольких задач order ещё не различается (все 0 по
// умолчанию, пока никто ничего не перетаскивал).
export class ReorderTasksDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  taskIds: string[];
}

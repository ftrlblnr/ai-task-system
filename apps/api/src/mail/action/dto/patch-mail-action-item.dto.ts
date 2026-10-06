import { IsBoolean, IsInt, IsObject, IsOptional, Min } from 'class-validator';

// Раздел 7 ТЗ — "принять/отклонить/изменить по каждой строке" (аналог
// task-extraction-modal.tsx на фронте, но с версионированием). selected —
// принять/снять конкретный пункт. parameters — правка значений (например,
// другая целевая папка у MOVE) — ЛЮБАЯ правка parameters обесценивает
// payloadHash и переводит пункт обратно в NEEDS_REVIEW, даже если он уже
// был согласован (раздел 14 ТЗ: "изменённые параметры требуют нового
// согласия").
export class PatchMailActionItemDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsBoolean()
  selected?: boolean;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;
}

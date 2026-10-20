import { IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

// Ручной порядок очереди (владелец 20.10.2026): перетащить вопрос на место
// перед beforeId; без beforeId — в конец.
export class ReorderReceptionRequestDto {
  @IsInt()
  @IsPositive()
  version: number;

  @IsOptional()
  @IsString()
  beforeId?: string;
}

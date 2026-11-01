import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { TaskPriority } from '@prisma/client';

// Утверждение поручений из встречи (AGENT_AND_MEETINGS.md, B.5). Правки
// руководителя перед утверждением — только то, что видно в строке панели:
// название, исполнитель, срок, приоритет. undefined — «не трогать», null —
// «снять» (исполнитель, срок).
export class ApproveProposalItemDto {
  @IsString()
  id: string;

  // Версия, которую видел руководитель: строку успели поменять в другой
  // вкладке — VERSION_CONFLICT по этому пункту, а не молчаливая перезапись.
  @IsInt()
  version: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  assigneeId?: string | null;

  // «ГГГГ-ММ-ДД» из поля даты (конец дня по местному времени) или полная ISO-дата.
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}(T.*)?$/)
  dueDate?: string | null;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority | null;
}

export class ApproveProposalsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ApproveProposalItemDto)
  items: ApproveProposalItemDto[];
}

export class RejectProposalsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids: string[];
}

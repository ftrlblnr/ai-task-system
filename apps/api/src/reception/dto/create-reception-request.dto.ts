import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsISO8601, IsOptional, IsString, Length, ValidateIf } from 'class-validator';
import { ReceptionRequestType } from '@prisma/client';

const EXPECTED_MINUTES_OPTIONS = [5, 10, 15, 30];
export const MAX_RECEPTION_ATTACHMENTS = 5;

export class CreateReceptionRequestDto {
  @IsString()
  @Length(5, 150)
  title: string;

  @IsString()
  @Length(10, 3000)
  description: string;

  @IsEnum(ReceptionRequestType)
  requestType: ReceptionRequestType;

  @IsOptional()
  @IsIn(EXPECTED_MINUTES_OPTIONS)
  expectedMinutes?: number;

  @IsOptional()
  @IsISO8601()
  desiredBy?: string;

  // Обязательна, если задан срок (раздел 5 ТЗ) — ValidateIf проверяет
  // ИСХОДНЫЙ объект (само DTO), не текущее поле, поэтому условие завязано
  // на desiredBy, а не на urgencyReason.
  @ValidateIf((dto: CreateReceptionRequestDto) => Boolean(dto.desiredBy))
  @IsString()
  @Length(5, 500)
  urgencyReason?: string;

  // Файлы к обращению (владелец 22.10.2026): id из POST /files/upload.
  // При правке — полный новый список (убранные файлы отвязываются).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECEPTION_ATTACHMENTS)
  @IsString({ each: true })
  fileIds?: string[];
}

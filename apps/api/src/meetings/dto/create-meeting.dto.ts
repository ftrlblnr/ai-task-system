import { IsDateString, IsString, MinLength } from 'class-validator';

export class CreateMeetingDto {
  @IsString()
  title: string;

  @IsDateString()
  meetingDate: string;

  // Раздел 8.1 ТЗ: сохраняем как есть, без изменений — источник истины.
  // Транскрипт не хранится (владелец 08.09.2026) — Plaud уже делает саммари сам.
  @IsString()
  @MinLength(1)
  rawSummary: string;
}

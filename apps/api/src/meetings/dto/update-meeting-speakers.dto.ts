import { IsObject } from 'class-validator';

// Владелец 09.09.2026: "Speaker N" -> реальное имя, руководитель вводит
// вручную (без AI). {"Speaker 1": "Иван Иванов", ...}
export class UpdateMeetingSpeakersDto {
  @IsObject()
  speakerNames: Record<string, string>;
}

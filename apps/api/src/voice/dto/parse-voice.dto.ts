import { IsOptional, IsString } from 'class-validator';

// Доп. текстовое поле в том же multipart-запросе, что и audio (владелец
// 09.09.2026) — диктовка со страницы встречи получает её саммари как
// контекст (см. VoiceService.parse).
export class ParseVoiceDto {
  @IsOptional()
  @IsString()
  meetingId?: string;
}

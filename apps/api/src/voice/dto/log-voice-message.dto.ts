import { IsString, MaxLength, MinLength } from 'class-validator';

// Фронтенд шлёт сюда финальный текст своего чат-пузыря ассистента (chat-
// реплика, итог действия или текст ошибки) в момент, когда он перестаёт
// быть "в процессе" — см. VoiceService.logAssistantMessage. Роль всегда
// ASSISTANT: реплику пользователя пишет сам сервер в VoiceService.parse.
export class LogVoiceMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
}

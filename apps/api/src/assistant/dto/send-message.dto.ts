import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// clientRequestId — идемпотентность (Stage 2 §29): фронтенд генерирует один
// раз на попытку отправки, сервер игнорирует повтор той же пары
// (conversationId, clientRequestId) — см. AssistantChatService.sendMessage.
export class SendMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientRequestId?: string;

  // Phase F — id уже загруженных через POST /files/upload FileArtifact.
  // Валидация владения — в AssistantChatService (FilesService.
  // assertOwnedFile), не здесь: DTO только проверяет форму запроса, не
  // право доступа. Невалидный/чужой id внутри массива не роняет отправку
  // сообщения целиком — тихо пропускается (см. AssistantChatService).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  attachmentIds?: string[];
}

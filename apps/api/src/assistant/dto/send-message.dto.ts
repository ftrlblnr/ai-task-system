import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
}

import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

// Зеркало AGENT_PAGE_CONTEXT_KINDS из packages/shared-types (api не
// подключает shared-types как зависимость, см. message-part-data.dto.ts).
export const PAGE_CONTEXT_KINDS = ['dashboard', 'task', 'mail', 'event', 'meeting', 'list'] as const;
export type PageContextKind = (typeof PAGE_CONTEXT_KINDS)[number];

// Редизайн web W2 — на что смотрит пользователь (панель агента). id —
// только подсказка: PageContextService сам загружает сущность с проверкой
// прав, нет прав или сущности — контекст молча не добавляется.
export class PageContextDto {
  @IsIn(PAGE_CONTEXT_KINDS)
  kind!: PageContextKind;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  route?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  filter?: string;
}

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

  @IsOptional()
  @ValidateNested()
  @Type(() => PageContextDto)
  context?: PageContextDto;
}

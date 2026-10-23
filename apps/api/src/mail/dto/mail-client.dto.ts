import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import type { MailDraftMode } from '@prisma/client';
import { MAX_RECIPIENTS } from '../mail-compose.service';
import { MAX_MESSAGES_PER_ACTION } from '../mail-message-actions.service';

// Почтовый клиент (владелец 23.10.2026): черновики, отправка, действия над письмами.

export class CreateDraftDto {
  @IsIn(['NEW', 'REPLY', 'REPLY_ALL', 'FORWARD'])
  mode!: MailDraftMode;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceMessageId?: string;
}

export class UpdateDraftDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  to?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  cc?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  bcc?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(998)
  subject?: string;

  // Длина проверяется в сервисе (MAX_BODY_CHARS) — понятной ошибкой.
  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  fileIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  forwardAttachmentIds?: string[];
}

export class MessageActionSpecDto {
  @IsIn(['read', 'flag', 'move', 'archive', 'trash', 'delete'])
  type!: 'read' | 'flag' | 'move' | 'archive' | 'trash' | 'delete';

  // Для read/flag: true — поставить, false — снять.
  @IsOptional()
  @IsBoolean()
  value?: boolean;

  // Для move — папка назначения (EmailFolder.id).
  @IsOptional()
  @IsString()
  @MaxLength(64)
  folderId?: string;
}

export class MessageActionsDto {
  @IsArray()
  @ArrayMaxSize(MAX_MESSAGES_PER_ACTION)
  @IsString({ each: true })
  ids!: string[];

  @ValidateNested()
  @Type(() => MessageActionSpecDto)
  action!: MessageActionSpecDto;
}

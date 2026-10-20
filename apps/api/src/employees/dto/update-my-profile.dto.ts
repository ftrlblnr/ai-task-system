import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// PATCH /me — владелец 20.10.2026: свой профиль правит любой пользователь.
// Только эти поля: роль, статус и логин меняет руководство.
export class UpdateMyProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsString()
  positionId?: string | null;

  @IsOptional()
  @IsString()
  directionId?: string | null;
}

export class ChangeMyPasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  newPassword!: string;
}

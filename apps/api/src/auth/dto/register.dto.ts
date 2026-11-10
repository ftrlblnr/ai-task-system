import { IsOptional, IsString, Length, MinLength } from 'class-validator';

// Логин — любая строка, не обязательно похожая на email (владелец
// 02.10.2026): поле `email` в базе нигде не используется для отправки
// писем, чисто идентификатор входа, поэтому @IsEmail() здесь намеренно НЕ
// используется (в отличие от CreateEmployeeDto). LoginDto с 10.11.2026 тоже
// принимает любую строку — иначе такой логин не смог бы войти.
export class RegisterDto {
  @IsString()
  @Length(3, 100)
  login: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @Length(2, 150)
  fullName: string;

  @IsOptional()
  @IsString()
  positionId?: string;

  @IsOptional()
  @IsString()
  directionId?: string;
}

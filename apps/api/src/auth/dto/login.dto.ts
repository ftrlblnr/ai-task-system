import { IsString, MaxLength, MinLength } from 'class-validator';

// Логин — любая строка (владелец 10.11.2026), как и при самостоятельной
// регистрации (RegisterDto): поле `email` в базе — идентификатор входа, а не
// обязательно адрес почты. Имя поля в запросе не меняем — клиенты шлют email.
export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

import { IsOptional, IsString } from 'class-validator';

export class TelegramAuthDto {
  // Сырая строка Telegram.WebApp.initData целиком (не initDataUnsafe) —
  // именно она подписана и подлежит проверке на бэкенде.
  @IsString()
  initData: string;

  // Владелец 02.10.2026: если initData ещё ни к кому не привязана и нет
  // start_param-приглашения — Mini App предлагает войти логином/паролем,
  // полученным при самостоятельной регистрации на сайте, и это сразу
  // привязывает telegramId (см. TelegramService.authenticate). Опциональны
  // — обычный повторный вход уже привязанного сотрудника их не передаёт.
  @IsOptional()
  @IsString()
  login?: string;

  @IsOptional()
  @IsString()
  password?: string;
}

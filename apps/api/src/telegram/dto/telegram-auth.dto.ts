import { IsString } from 'class-validator';

export class TelegramAuthDto {
  // Сырая строка Telegram.WebApp.initData целиком (не initDataUnsafe) —
  // именно она подписана и подлежит проверке на бэкенде.
  @IsString()
  initData: string;
}

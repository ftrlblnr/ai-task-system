import { Module } from '@nestjs/common';
import { PlaudOAuthController } from './plaud-oauth.controller';
import { PlaudOAuthService } from './plaud-oauth.service';
import { PlaudApiService } from './plaud-api.service';
import { PlaudSyncService } from './plaud-sync.service';
import { PlaudSyncCron } from './plaud-sync.cron';

// JwtAuthGuard/RolesGuard работают без импорта AuthModule здесь — Passport
// JWT-стратегия регистрируется глобально через AuthModule в AppModule (тот
// же паттерн, что у TasksModule). Нет отдельного публичного callback-
// контроллера — подключение идёт через вставленный вручную refresh_token
// (POST plaud/connect-token), не через браузерный OAuth-редирект (см.
// комментарий в PlaudOAuthService).
@Module({
  controllers: [PlaudOAuthController],
  providers: [PlaudOAuthService, PlaudApiService, PlaudSyncService, PlaudSyncCron],
})
export class PlaudModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TelegramBotService } from './telegram-bot.service';

@Module({
  imports: [AuthModule],
  controllers: [TelegramController],
  providers: [TelegramService, TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramModule {}

import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { RealtimeService, type RealtimeTopic } from './realtime.service';

const TOPICS: readonly RealtimeTopic[] = ['reception', 'assistant', 'legal'];
// nginx закрывает простаивающее соединение через 60 с (proxy_read_timeout).
const HEARTBEAT_MS = 25_000;

@UseGuards(JwtAuthGuard)
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Get('stream')
  stream(@Query('topic') topic: string | undefined, @CurrentUser() user: AuthenticatedUser, @Res() res: Response): void {
    if (!TOPICS.includes(topic as RealtimeTopic)) throw new BadRequestException('Неизвестная тема');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    // Личная тема — подписка на канал этого пользователя (realtime.service.ts).
    const unsubscribe = this.realtime.subscribe(
      topic as RealtimeTopic,
      () => {
        res.write(`event: change\ndata: ${JSON.stringify({ topic })}\n\n`);
      },
      user.id,
    );
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}

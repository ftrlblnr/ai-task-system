import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RealtimeService, type RealtimeTopic } from './realtime.service';

const TOPICS: readonly RealtimeTopic[] = ['reception'];
// nginx закрывает простаивающее соединение через 60 с (proxy_read_timeout).
const HEARTBEAT_MS = 25_000;

@UseGuards(JwtAuthGuard)
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Get('stream')
  stream(@Query('topic') topic: string | undefined, @Res() res: Response): void {
    if (!TOPICS.includes(topic as RealtimeTopic)) throw new BadRequestException('Неизвестная тема');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    const unsubscribe = this.realtime.subscribe(topic as RealtimeTopic, () => {
      res.write(`event: change\ndata: ${JSON.stringify({ topic })}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}

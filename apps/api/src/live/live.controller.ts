import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CreateLiveSessionDto } from './dto/create-live-session.dto';
import { LiveClientTimingDto } from './dto/live-client-timing.dto';
import { LiveService } from './live.service';

// Без @Roles(...) — как AssistantChatController: живой голос доступен любому
// сотруднику, а что именно он может сделать, решают те же tools/RBAC
// Assistant Core (видимость инструментов по роли).
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('live')
export class LiveController {
  constructor(private readonly live: LiveService) {}

  @Get('status')
  status() {
    return { enabled: this.live.isEnabled() };
  }

  @Post('sessions')
  create(@Body() dto: CreateLiveSessionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.live.createSession(user, dto);
  }

  @Get('sessions/:id/ready')
  ready(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.live.waitReady(user, id);
  }

  @Post('sessions/:id/timing')
  @HttpCode(204)
  timing(@Param('id') id: string, @Body() dto: LiveClientTimingDto, @CurrentUser() user: AuthenticatedUser) {
    this.live.recordClientTiming(user, id, { ...dto });
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  close(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    this.live.closeForUser(user, id);
  }
}

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { RoutineChannel, RoutineMode } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MANAGER_ROLES } from '../auth/roles';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { RoutinesService } from './routines.service';
import { ROUTINE_PROMPT_MAX, ROUTINE_TITLE_MAX } from './routine-catalog';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// Отдельные классы create/update: class-validator переносит @IsOptional
// родителя на наследника (см. skills.controller.ts).
class CreateRoutineDto {
  @IsString() @MaxLength(ROUTINE_TITLE_MAX) title!: string;
  @IsOptional() @IsString() skillId?: string | null;
  @IsOptional() @IsString() @MaxLength(ROUTINE_PROMPT_MAX) prompt?: string | null;
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) days!: number[];
  @IsString() @Matches(TIME_RE) time!: string;
  @IsEnum(RoutineMode) mode!: RoutineMode;
  @IsEnum(RoutineChannel) channel!: RoutineChannel;
  @IsOptional() @IsInt() @Min(0) weeklyTokenCap?: number | null;
}

class UpdateRoutineDto {
  @IsOptional() @IsString() @MaxLength(ROUTINE_TITLE_MAX) title?: string;
  @IsOptional() @IsString() skillId?: string | null;
  @IsOptional() @IsString() @MaxLength(ROUTINE_PROMPT_MAX) prompt?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) days?: number[];
  @IsOptional() @IsString() @Matches(TIME_RE) time?: string;
  @IsOptional() @IsEnum(RoutineMode) mode?: RoutineMode;
  @IsOptional() @IsEnum(RoutineChannel) channel?: RoutineChannel;
  @IsOptional() @IsInt() @Min(0) weeklyTokenCap?: number | null;
  @IsOptional() @IsIn(['ACTIVE', 'PAUSED']) state?: 'ACTIVE' | 'PAUSED';
}

class RunRoutineDto {
  @IsOptional() @IsString() @MaxLength(100) clientRequestId?: string;
}

function runState(r: { id: string; status: string; conversationId: string | null; error: string | null }) {
  return { id: r.id, status: r.status, conversationId: r.conversationId, error: r.error };
}

// Регламенты (ARMS, фаза 4) — только руководство, каждый видит свои.
@Controller('routines')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MANAGER_ROLES)
export class RoutinesController {
  constructor(private readonly routines: RoutinesService) {}

  @Get()
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.routines.overview(user.id);
  }

  @Get('runs/:runId')
  async getRun(@CurrentUser() user: AuthenticatedUser, @Param('runId') runId: string) {
    return runState(await this.routines.getRun(user.id, runId));
  }

  @Get(':id/runs')
  runs(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.routines.runs(user.id, id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRoutineDto) {
    return this.routines.create(user.id, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateRoutineDto) {
    return this.routines.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.routines.remove(user.id, id);
  }

  @Post(':id/run')
  async run(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: RunRoutineDto) {
    return runState(await this.routines.enqueueRun(user.id, id, dto.clientRequestId));
  }
}

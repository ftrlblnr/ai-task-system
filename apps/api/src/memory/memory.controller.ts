import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { MemoryKind, MemoryStatus } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { MEMORY_TEXT_MAX } from './memory-index';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MANAGER_ROLES } from '../auth/roles';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { MEMORY_DETAILS_MAX, MemoryService, toMemoryView } from './memory.service';

class ListMemoryQueryDto {
  @IsOptional()
  @IsEnum(MemoryStatus)
  status?: MemoryStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

class CreateMemoryDto {
  @IsEnum(MemoryKind)
  kind: MemoryKind;

  @IsString()
  @MinLength(2)
  @MaxLength(MEMORY_TEXT_MAX)
  text: string;

  @IsOptional()
  @IsString()
  @MaxLength(MEMORY_DETAILS_MAX)
  details?: string;
}

class UpdateMemoryDto {
  @IsOptional()
  @IsEnum(MemoryKind)
  kind?: MemoryKind;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(MEMORY_TEXT_MAX)
  text?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(MEMORY_DETAILS_MAX)
  details?: string | null;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';
}

// «Память» (ARMS, фаза 1) — сначала руководству (OWNER/ADMIN), каждый видит
// только свою.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MANAGER_ROLES)
@Controller('memory')
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get()
  async list(@Query() query: ListMemoryQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return (await this.memory.list(user.id, query)).map(toMemoryView);
  }

  @Post()
  async create(@Body() dto: CreateMemoryDto, @CurrentUser() user: AuthenticatedUser) {
    return toMemoryView(await this.memory.create(user.id, dto));
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateMemoryDto, @CurrentUser() user: AuthenticatedUser) {
    return toMemoryView(await this.memory.update(user.id, id, dto));
  }

  @Post(':id/accept')
  async accept(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return toMemoryView(await this.memory.decide(user.id, id, true));
  }

  @Post(':id/dismiss')
  async dismiss(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return toMemoryView(await this.memory.decide(user.id, id, false));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.memory.remove(user.id, id);
  }
}

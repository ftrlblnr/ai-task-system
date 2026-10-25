import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Skill, SkillEffort, SkillFeedback, SkillKind, SkillModel, SkillOutput, SkillRevision, SkillRun } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MANAGER_ROLES } from '../auth/roles';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { SkillsService } from './skills.service';
import { SKILL_INSTRUCTIONS_MAX, SKILL_SLUG_MAX, SKILL_SLUG_RE, SKILL_TOOL_LABELS } from './skill-catalog';

class UpdateSkillDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) title?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) description?: string;
  @IsOptional() @IsEnum(SkillKind) kind?: SkillKind;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(SKILL_INSTRUCTIONS_MAX) instructions?: string;
  @IsOptional() @IsEnum(SkillModel) model?: SkillModel;
  @IsOptional() @IsEnum(SkillEffort) effort?: SkillEffort;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) allowedTools?: string[];
  @IsOptional() @IsEnum(SkillOutput) output?: SkillOutput;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

// Отдельный класс, не наследник UpdateSkillDto: class-validator переносит
// @IsOptional родителя на наследника, и обязательные поля стали бы необязательными.
class CreateSkillDto {
  @IsString() @MaxLength(SKILL_SLUG_MAX) @Matches(SKILL_SLUG_RE, { message: 'Команда — строчные буквы и цифры, слова через дефис' }) slug!: string;
  @IsString() @MinLength(2) @MaxLength(80) title!: string;
  @IsString() @MinLength(2) @MaxLength(200) description!: string;
  @IsEnum(SkillKind) kind!: SkillKind;
  @IsString() @MinLength(10) @MaxLength(SKILL_INSTRUCTIONS_MAX) instructions!: string;
  @IsEnum(SkillModel) model!: SkillModel;
  @IsEnum(SkillEffort) effort!: SkillEffort;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) allowedTools?: string[];
  @IsOptional() @IsEnum(SkillOutput) output?: SkillOutput;
}

class RunSkillDto {
  @IsOptional() @IsString() @MaxLength(2000) text?: string;
  @IsOptional() @IsString() @MaxLength(100) clientRequestId?: string;
}

class FeedbackDto {
  @IsEnum(SkillFeedback) value!: SkillFeedback;
  @IsOptional() @IsString() @MaxLength(1000) text?: string;
}

class RevisionRequestDto {
  @IsIn(['FEEDBACK', 'SENT_MAIL']) source!: 'FEEDBACK' | 'SENT_MAIL';
}

function skillView(s: Skill, userId: string) {
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    description: s.description,
    kind: s.kind,
    instructions: s.instructions,
    model: s.model,
    effort: s.effort,
    allowedTools: s.allowedTools,
    output: s.output,
    enabled: s.enabled,
    version: s.version,
    shared: s.ownerId === null,
    own: s.ownerId === userId,
    updatedAt: s.updatedAt.toISOString(),
  };
}

function revisionView(r: SkillRevision) {
  return {
    id: r.id,
    source: r.source,
    status: r.status,
    baseVersion: r.baseVersion,
    instructions: r.instructions,
    reason: r.reason,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
  };
}

function runView(r: SkillRun) {
  return { id: r.id, status: r.status, conversationId: r.conversationId, error: r.error, createdAt: r.createdAt.toISOString() };
}

// ARMS, фаза 3 — навыки: только руководство.
@Controller('skills')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MANAGER_ROLES)
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    const list = await this.skills.list(user.id);
    return list.map((s) => ({ ...skillView(s, user.id), runs30d: s.runs30d, pendingRevisions: s.pendingRevisions }));
  }

  @Get('tools')
  tools() {
    return Object.entries(SKILL_TOOL_LABELS).map(([name, label]) => ({ name, label }));
  }

  @Get('runs/:runId')
  async run(@Param('runId') runId: string, @CurrentUser() user: AuthenticatedUser) {
    return runView(await this.skills.getRun(user.id, runId));
  }

  @Post('runs/:runId/feedback')
  async feedback(@Param('runId') runId: string, @Body() dto: FeedbackDto, @CurrentUser() user: AuthenticatedUser) {
    return this.skills.feedback(user.id, runId, dto.value, dto.text);
  }

  @Post('revisions/:id/apply')
  async apply(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return skillView(await this.skills.applyRevision(user.id, id), user.id);
  }

  @Post('revisions/:id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.skills.rejectRevision(user.id, id);
  }

  @Get(':id')
  async detail(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const d = await this.skills.detail(user.id, id);
    return {
      skill: skillView(d.skill, user.id),
      revisions: d.revisions.map(revisionView),
      feedback: d.feedback.map((f) => ({ ...f, feedbackAt: f.feedbackAt?.toISOString() ?? null })),
      stats: d.stats,
    };
  }

  @Post()
  async create(@Body() dto: CreateSkillDto, @CurrentUser() user: AuthenticatedUser) {
    return skillView(await this.skills.create(user.id, dto), user.id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateSkillDto, @CurrentUser() user: AuthenticatedUser) {
    return skillView(await this.skills.update(user.id, id, dto), user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.skills.remove(user.id, id);
  }

  @Post(':id/run')
  async runSkill(@Param('id') id: string, @Body() dto: RunSkillDto, @CurrentUser() user: AuthenticatedUser) {
    return runView(await this.skills.enqueueRun(user.id, id, dto.text ?? '', dto.clientRequestId));
  }

  @Post(':id/revisions')
  async requestRevision(@Param('id') id: string, @Body() dto: RevisionRequestDto, @CurrentUser() user: AuthenticatedUser) {
    return revisionView(await this.skills.requestRevision(user.id, id, dto.source));
  }
}

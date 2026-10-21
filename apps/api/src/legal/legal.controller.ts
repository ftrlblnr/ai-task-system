import { BadGatewayException, BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { legalAllowedForRole } from './legal-access';
import { LegalAgentError, LegalAgentService } from './legal-agent.service';
import { formatLegalAnswer } from './legal-agent';
import { LegalAskDto } from './dto/legal-ask.dto';
import { CreateLegalReviewDto } from './dto/create-legal-review.dto';
import { LegalReviewService, toReviewView } from './legal-review.service';
import { RealtimeService } from '../realtime/realtime.service';

// Агент-юрист (handoff, раздел 3.2). Выключенный флаг или роль вне
// LEGAL_AGENT_ROLES — 404, как будто раздела нет (тот же приём, что
// LIVE_VOICE_ENABLED у /live).
@Controller('legal')
@UseGuards(JwtAuthGuard)
export class LegalController {
  constructor(
    private readonly config: ConfigService,
    private readonly agent: LegalAgentService,
    private readonly audit: AuditService,
    private readonly reviews: LegalReviewService,
    private readonly realtime: RealtimeService,
  ) {}

  private assertAvailable(user: AuthenticatedUser) {
    if (!legalAllowedForRole(this.config, user.role)) throw new NotFoundException();
  }

  // Для меню web: раздел «Юрист» показывается, только если доступен этой
  // роли. Единственный маршрут без 404 при выключенном флаге.
  @Get('status')
  status(@CurrentUser() user: AuthenticatedUser) {
    return { enabled: legalAllowedForRole(this.config, user.role) };
  }

  // Синхронно: вопрос по НПА — 4–8 обращений к модели, до пары минут.
  // Разбор договора (дольше) идёт фоновым заданием, не здесь.
  @Post('ask')
  async ask(@Body() dto: LegalAskDto, @CurrentUser() user: AuthenticatedUser) {
    this.assertAvailable(user);
    try {
      const answer = await this.agent.ask(dto.question);
      void this.audit.log(user.id, 'LEGAL_ASK', 'LegalQuestion', 'npa', {
        rounds: answer.rounds,
        citations: answer.citations.length,
        unverified: answer.citations.filter((c) => !c.verified).length,
      });
      // markdown — та же вёрстка, что ответ legal_ask в чате.
      return { ...answer, markdown: formatLegalAnswer(answer) };
    } catch (err) {
      if (err instanceof LegalAgentError) throw new BadGatewayException({ code: `LEGAL_${err.code}`, message: 'Агент-юрист не смог подготовить ответ, попробуйте переформулировать вопрос' });
      throw err;
    }
  }

  // Разбор договора — фоновое задание (legal-review-execution.service.ts),
  // ответ сразу: QUEUED. Idempotency-Key обязателен: повтор того же запроса
  // (двойной клик, ретрай после таймаута) вернёт тот же разбор.
  @Post('reviews')
  async createReview(
    @Body() dto: CreateLegalReviewDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    this.assertAvailable(user);
    if (!idemKey) throw new BadRequestException('Заголовок Idempotency-Key обязателен для этого действия');
    const { run, created } = await this.reviews.create(user, { fileId: dto.fileId, focus: dto.focus, dedupeKey: `http:${user.id}:${idemKey}` });
    if (created) {
      void this.audit.log(user.id, 'LEGAL_REVIEW_REQUESTED', 'LegalReviewRun', run.id, { fileId: run.fileId, source: 'web' });
      this.realtime.publish('legal', user.id);
    }
    return toReviewView(run);
  }

  @Get('reviews')
  async listReviews(@CurrentUser() user: AuthenticatedUser, @Query('limit') limit?: string) {
    this.assertAvailable(user);
    return this.reviews.list(user, Number(limit) || 20);
  }

  @Get('reviews/:id')
  async getReview(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    this.assertAvailable(user);
    return this.reviews.get(user, id);
  }
}

import { BadGatewayException, Body, Controller, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { legalAllowedForRole } from './legal-access';
import { LegalAgentError, LegalAgentService } from './legal-agent.service';
import { LegalAskDto } from './dto/legal-ask.dto';

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
  ) {}

  private assertAvailable(user: AuthenticatedUser) {
    if (!legalAllowedForRole(this.config, user.role)) throw new NotFoundException();
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
      return answer;
    } catch (err) {
      if (err instanceof LegalAgentError) throw new BadGatewayException({ code: `LEGAL_${err.code}`, message: 'Агент-юрист не смог подготовить ответ, попробуйте переформулировать вопрос' });
      throw err;
    }
  }
}

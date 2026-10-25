import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import type { AiUsageGroupBy } from '@ai-task-system/shared-types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MANAGER_ROLES } from '../auth/roles';
import { AiUsageService } from './ai-usage.service';

export class AiUsageSummaryQueryDto {
  @IsOptional()
  @IsIn(['7', '30'])
  days?: '7' | '30';

  @IsOptional()
  @IsIn(['feature', 'model'])
  groupBy?: AiUsageGroupBy;
}

// «Расход ИИ» (ARMS, фаза 2) — руководству (OWNER/ADMIN): сводка журнала
// вызовов моделей по функциям и моделям.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MANAGER_ROLES)
@Controller('ai-usage')
export class AiUsageController {
  constructor(private readonly aiUsage: AiUsageService) {}

  @Get('summary')
  summary(@Query() query: AiUsageSummaryQueryDto) {
    return this.aiUsage.summary(Number(query.days ?? 7), query.groupBy ?? 'feature');
  }
}

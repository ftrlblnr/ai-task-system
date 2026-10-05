import { Controller, Get, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { DashboardService } from './dashboard.service';

// «Стол руководителя» (ТЗ v1.0, 05.10.2026) — раздел 4: только OWNER,
// проверено на сервере, а не скрытием карточек на клиенте.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.OWNER)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  getOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboardService.getOverview(user);
  }
}

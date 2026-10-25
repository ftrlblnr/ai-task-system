import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MANAGER_ROLES } from '../auth/roles';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { RecommendationsService } from './recommendations.service';

class SetStatusDto {
  @IsIn(['NEW', 'IN_CART', 'DISMISSED']) status!: 'NEW' | 'IN_CART' | 'DISMISSED';
}

class ApplyDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) ids!: string[];
}

// Рекомендации (ARMS, фаза 5) — только руководство, каждый видит свои.
@Controller('recommendations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MANAGER_ROLES)
export class RecommendationsController {
  constructor(private readonly recommendations: RecommendationsService) {}

  @Get()
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.recommendations.overview(user.id);
  }

  @Post('generate')
  generate(@CurrentUser() user: AuthenticatedUser) {
    return this.recommendations.requestNow(user.id);
  }

  @Post('apply')
  apply(@CurrentUser() user: AuthenticatedUser, @Body() dto: ApplyDto) {
    return this.recommendations.apply(user, dto.ids);
  }

  @Patch(':id')
  setStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.recommendations.setStatus(user.id, id, dto.status);
  }
}

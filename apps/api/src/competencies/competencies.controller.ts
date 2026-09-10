import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CompetenciesService } from './competencies.service';
import { CompetencyDto } from './dto/competency.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('competencies')
export class CompetenciesController {
  constructor(private readonly competenciesService: CompetenciesService) {}

  @Get()
  findAll() {
    return this.competenciesService.findAll();
  }

  @Post()
  @Roles(Role.OWNER)
  create(@Body() dto: CompetencyDto) {
    return this.competenciesService.create(dto);
  }

  @Patch(':id')
  @Roles(Role.OWNER)
  update(@Param('id') id: string, @Body() dto: Partial<CompetencyDto>) {
    return this.competenciesService.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.competenciesService.remove(id);
  }
}

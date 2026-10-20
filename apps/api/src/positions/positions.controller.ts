import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PositionsService } from './positions.service';
import { CreatePositionDto } from './dto/position.dto';

@UseGuards(JwtAuthGuard)
@Controller('positions')
export class PositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  @Get()
  findAll() {
    return this.positionsService.findAll();
  }

  // Владелец 20.10.2026 — любой пользователь может завести новую
  // должность/направление, заполняя свой профиль.
  @Post()
  create(@Body() dto: CreatePositionDto) {
    return this.positionsService.create(dto);
  }
}

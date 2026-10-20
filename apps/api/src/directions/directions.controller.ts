import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DirectionsService } from './directions.service';
import { CreateDirectionDto } from './dto/direction.dto';

@UseGuards(JwtAuthGuard)
@Controller('directions')
export class DirectionsController {
  constructor(private readonly directionsService: DirectionsService) {}

  @Get()
  findAll() {
    return this.directionsService.findAll();
  }

  // Владелец 20.10.2026 — любой пользователь может завести новую
  // должность/направление, заполняя свой профиль.
  @Post()
  create(@Body() dto: CreateDirectionDto) {
    return this.directionsService.create(dto);
  }
}

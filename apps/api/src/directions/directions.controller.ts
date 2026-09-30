import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DirectionsService } from './directions.service';
import { CreateDirectionDto } from './dto/direction.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('directions')
export class DirectionsController {
  constructor(private readonly directionsService: DirectionsService) {}

  @Get()
  findAll() {
    return this.directionsService.findAll();
  }

  @Post()
  @Roles(Role.OWNER)
  create(@Body() dto: CreateDirectionDto) {
    return this.directionsService.create(dto);
  }
}

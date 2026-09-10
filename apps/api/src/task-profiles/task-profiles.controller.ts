import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { TaskProfilesService } from './task-profiles.service';
import { CreateTaskProfileDto, UpdateTaskProfileDto } from './dto/task-profile.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('task-profiles')
export class TaskProfilesController {
  constructor(private readonly taskProfilesService: TaskProfilesService) {}

  @Get()
  findAll() {
    return this.taskProfilesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.taskProfilesService.findOne(id);
  }

  @Post()
  @Roles(Role.OWNER)
  create(@Body() dto: CreateTaskProfileDto) {
    return this.taskProfilesService.create(dto);
  }

  @Patch(':id')
  @Roles(Role.OWNER)
  update(@Param('id') id: string, @Body() dto: UpdateTaskProfileDto) {
    return this.taskProfilesService.update(id, dto);
  }
}

import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { MeetingsService } from './meetings.service';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { UpdateMeetingSpeakersDto } from './dto/update-meeting-speakers.dto';
import { CreateTasksFromMeetingDto } from './dto/create-tasks-from-meeting.dto';

// Встречи целиком видит только руководитель (раздел 5 ТЗ) — протокол
// может содержать переговоры, кадровые и финансовые темы, не только
// содержимое задач, которые из него извлечены. Подчинённый получает
// только краткий sourceContext на самой задаче (см. TasksService),
// не доступ к этому контроллеру.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('meetings')
@Roles(Role.OWNER)
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  findAll() {
    return this.meetingsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.meetingsService.findOne(id, user.id);
  }

  @Post()
  create(@Body() dto: CreateMeetingDto, @CurrentUser() user: AuthenticatedUser) {
    return this.meetingsService.create(dto, user.id);
  }

  @Patch(':id/speakers')
  updateSpeakers(@Param('id') id: string, @Body() dto: UpdateMeetingSpeakersDto) {
    return this.meetingsService.updateSpeakers(id, dto.speakerNames);
  }

  @Post(':id/extract-tasks')
  async extractTasks(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return { drafts: await this.meetingsService.extractTasks(id, user.id) };
  }

  @Post(':id/tasks')
  createTasksFromMeeting(
    @Param('id') id: string,
    @Body() dto: CreateTasksFromMeetingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.createTasksFromMeeting(id, dto.tasks, user);
  }
}

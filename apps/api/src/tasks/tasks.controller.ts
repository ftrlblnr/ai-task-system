import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { AddWatcherDto } from './dto/add-watcher.dto';
import { ReorderTasksDto } from './dto/reorder-tasks.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.tasksService.findAll(user);
  }

  // ВАЖНО: должен идти раньше @Patch(':id') — иначе Nest матчит
  // PATCH /tasks/reorder как @Patch(':id') с id="reorder" (первое
  // совпадение по порядку объявления маршрутов побеждает).
  @Patch('reorder')
  reorder(@Body() dto: ReorderTasksDto, @CurrentUser() user: AuthenticatedUser) {
    return this.tasksService.reorder(dto.taskIds, user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tasksService.findOne(id, user);
  }

  // Раздел 5 ТЗ (скорректировано владельцем 28.08.2026): задачи друг другу,
  // включая руководителю, может ставить любой участник закрытого круга —
  // это больше не привилегия только руководителя. Исключение — задачи из
  // Plaud-встречи (sourceMeetingId): их по-прежнему ставит только
  // руководитель, проверяется в TasksService.create.
  @Post()
  create(@Body() dto: CreateTaskDto, @CurrentUser() user: AuthenticatedUser) {
    return this.tasksService.create(dto, user);
  }

  // Редактировать может руководитель или сам постановщик задачи — проверка
  // по конкретной задаче, поэтому в сервисе, а не через @Roles.
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTaskDto, @CurrentUser() user: AuthenticatedUser) {
    return this.tasksService.update(id, dto, user);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.updateStatus(id, dto.status, user);
  }

  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @Body() dto: CreateCommentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.addComment(id, dto, user);
  }

  // Наблюдатели — self-service подписка/отписка, владелец может управлять
  // за других (проверка по конкретной задаче в сервисе, не через @Roles).
  @Post(':id/watchers')
  addWatcher(@Param('id') id: string, @Body() dto: AddWatcherDto, @CurrentUser() user: AuthenticatedUser) {
    return this.tasksService.addWatcher(id, dto.employeeId, user);
  }

  @Delete(':id/watchers/:employeeId')
  removeWatcher(
    @Param('id') id: string,
    @Param('employeeId') employeeId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tasksService.removeWatcher(id, employeeId, user);
  }

  // Удалить может руководитель или сам постановщик задачи — та же граница,
  // что и у общего редактирования (проверка по конкретной задаче, поэтому
  // в сервисе, а не через @Roles).
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tasksService.remove(id, user);
  }
}

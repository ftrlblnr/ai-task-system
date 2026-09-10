import { Type } from 'class-transformer';
import { ValidateNested, IsArray, ArrayMinSize } from 'class-validator';
import { CreateTaskDto } from '../../tasks/dto/create-task.dto';

// Пачка задач, подтверждённых руководителем в модалке ревью (владелец
// 09.09.2026) — sourceMeetingId каждой задаче подставляет сервис из :id в
// URL, а не берётся из тела запроса (см. MeetingsService.createTasksFromMeeting).
export class CreateTasksFromMeetingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateTaskDto)
  tasks: CreateTaskDto[];
}

import { IsOptional, IsString } from 'class-validator';

// employeeId не задан — актор подписывается сам на себя (self-service,
// как follow/unfollow в Asana); задан — владелец добавляет наблюдателем
// другого (проверка роли — в TasksService.addWatcher).
export class AddWatcherDto {
  @IsOptional()
  @IsString()
  employeeId?: string;
}

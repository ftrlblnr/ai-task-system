import { IsInt, IsOptional, Min } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { CreateEventDto } from './create-event.dto';

// Календарный агент, раздел 17 ТЗ — version НЕОБЯЗАТЕЛЕН здесь намеренно
// (расширение, не замена): существующий веб-календарь/голосовой агент
// пока не передают его, правка идёт как раньше (last-write-wins). Если
// version передан — EventsService.update проверяет его атомарно и
// отвечает 409 при несовпадении. Новые клиенты (фронтенд, следующим
// заходом) должны начать передавать его, чтобы получить защиту от
// потерянной правки.
export class UpdateEventDto extends PartialType(CreateEventDto) {
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

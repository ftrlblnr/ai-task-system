import { IsInt, IsPositive, Min } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { CreateReceptionRequestDto } from './create-reception-request.dto';

// version — раздел 7.1 ТЗ: клиент передаёт ожидаемую версию при каждом
// изменении, несовпадение → 409 VERSION_CONFLICT. PartialType(Create...) —
// редактирование может менять любое подмножество полей, кроме version,
// который здесь обязателен (не наследуется от Create, своё поле).
export class EditReceptionRequestDto extends PartialType(CreateReceptionRequestDto) {
  @IsInt()
  @Min(1)
  version: number;
}

export class VersionOnlyDto {
  @IsInt()
  @IsPositive()
  version: number;
}

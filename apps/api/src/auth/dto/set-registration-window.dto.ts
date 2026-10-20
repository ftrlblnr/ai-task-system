import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class SetRegistrationWindowDto {
  @IsBoolean()
  isOpen: boolean;

  // Срок окна в днях при открытии (владелец 20.10.2026); без него — до
  // ручного закрытия, как было раньше.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

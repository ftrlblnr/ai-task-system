import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Раздел 9/17 ТЗ — ручное создание папки владельцем, когда авто-поиск
// (\Archive и т.п.) не нашёл подходящей живьём и нужно явно выбрать/создать.
export class CreateMailFolderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  parentPath?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;
}

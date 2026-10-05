import { IsString, Length } from 'class-validator';

export class RenameConversationDto {
  @IsString()
  @Length(1, 200)
  title: string;
}

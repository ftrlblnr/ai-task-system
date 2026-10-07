import { ArrayMinSize, IsArray, IsInt, IsString, Min } from 'class-validator';

export class ApproveCalendarActionsDto {
  @IsInt()
  @Min(1)
  planVersion!: number;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  actionIds!: string[];
}

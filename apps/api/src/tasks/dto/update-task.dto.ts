import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateTaskDto } from './create-task.dto';

export class UpdateTaskDto extends PartialType(
  OmitType(CreateTaskDto, ['sourceMeetingId', 'sourceTimestamp', 'sourceContext'] as const),
) {}

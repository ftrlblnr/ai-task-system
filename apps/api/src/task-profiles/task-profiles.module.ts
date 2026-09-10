import { Module } from '@nestjs/common';
import { TaskProfilesController } from './task-profiles.controller';
import { TaskProfilesService } from './task-profiles.service';

@Module({
  controllers: [TaskProfilesController],
  providers: [TaskProfilesService],
  exports: [TaskProfilesService],
})
export class TaskProfilesModule {}

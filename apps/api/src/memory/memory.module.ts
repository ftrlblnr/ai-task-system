import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';
import { MemorySuggestService } from './memory-suggest.service';

@Module({
  controllers: [MemoryController],
  providers: [MemoryService, MemorySuggestService],
  exports: [MemoryService],
})
export class MemoryModule {}

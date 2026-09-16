import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { LocalFileStorageService } from './file-storage.service';

@Module({
  controllers: [FilesController],
  providers: [FilesService, LocalFileStorageService],
  exports: [FilesService],
})
export class FilesModule {}

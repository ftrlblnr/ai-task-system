import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FILE_STORAGE, LocalFileStorageService } from './file-storage.service';
import { FilesCleanupCron } from './files-cleanup.cron';

@Module({
  controllers: [FilesController],
  // FILE_STORAGE — Phase F.1: FilesService/крон зависят от интерфейса
  // FileStorage, не от конкретного класса — замена на S3/MinIO позже
  // меняется здесь, в одной строке, а не во всех потребителях.
  providers: [FilesService, LocalFileStorageService, FilesCleanupCron, { provide: FILE_STORAGE, useClass: LocalFileStorageService }],
  exports: [FilesService],
})
export class FilesModule {}

import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FILE_STORAGE, LocalFileStorageService } from './file-storage.service';
import { StorageRegistry } from './storage-registry.service';
import { FilesCleanupCron } from './files-cleanup.cron';

@Module({
  controllers: [FilesController],
  // FILE_STORAGE — Phase F.1: FilesService/крон зависят от интерфейса
  // FileStorage, не от конкретного класса — замена на S3/MinIO позже
  // меняется здесь, в одной строке, а не во всех потребителях.
  //
  // useExisting, не useClass (Stage 2, Phase H.2, аудит 20.09.2026, P3) —
  // useClass создавал ВТОРОЙ экземпляр LocalFileStorageService помимо того,
  // что уже зарегистрирован как обычный provider (два independent
  // instance с собственным internal state — на LocalFileStorageService
  // это сегодня безобидно, ready/uploadDir не хранят ничего специфичного
  // для конкретного запроса, но общий принцип DI — один provider, один
  // экземпляр — соблюдать в любом случае). StorageRegistry (P2) — новый
  // provider, инжектит тот же единственный LocalFileStorageService.
  providers: [
    FilesService,
    LocalFileStorageService,
    StorageRegistry,
    FilesCleanupCron,
    { provide: FILE_STORAGE, useExisting: LocalFileStorageService },
  ],
  exports: [FilesService],
})
export class FilesModule {}

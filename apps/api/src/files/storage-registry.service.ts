import { Injectable, OnModuleInit } from '@nestjs/common';
import { LocalFileStorageService, type FileStorage } from './file-storage.service';

// Stage 2, Phase H.2 (внешний аудит 20.09.2026, P2) — заготовка на будущее
// (local -> MinIO/S3): FILE_STORAGE-токен (см. file-storage.service.ts)
// определяет провайдер для НОВЫХ загрузок, но download/delete читают
// СУЩЕСТВУЮЩИЙ файл, у которого уже есть свой storageProvider — если он не
// совпадает с текущим FILE_STORAGE (например, после переключения на новый
// провайдер, но со старыми файлами, ещё не мигрированными), нужно читать
// через ТУ реализацию, что реально его сохранила, а не через ту, что
// сейчас настроена для новых файлов.
//
// Сегодня провайдер всего один ('local') — эта прослойка ничего не меняет
// по факту, только даёт точку расширения: второй провайдер регистрируется
// здесь (constructor + onModuleInit), FilesService/FilesCleanupCron не
// трогаются.
@Injectable()
export class StorageRegistry implements OnModuleInit {
  private readonly byProvider = new Map<string, FileStorage>();

  constructor(private readonly local: LocalFileStorageService) {}

  onModuleInit(): void {
    this.register(this.local);
  }

  register(storage: FileStorage): void {
    this.byProvider.set(storage.provider, storage);
  }

  resolve(provider: string): FileStorage {
    const storage = this.byProvider.get(provider);
    if (!storage) {
      throw new Error(`Неизвестный storage provider: "${provider}"`);
    }
    return storage;
  }
}

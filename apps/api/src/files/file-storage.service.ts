import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Phase F.1 (аудит 16.09.2026) — FilesService зависел напрямую от
// конкретного класса LocalFileStorageService, не от интерфейса: замена на
// S3/MinIO потребовала бы трогать FilesService, а не только этот файл.
// Токен + интерфейс — FilesService/крон инжектят FILE_STORAGE, реализация
// подставляется в files.module.ts, сам контракт не изменился.
export const FILE_STORAGE = Symbol('FILE_STORAGE');

export interface FileStorage {
  save(buffer: Buffer): Promise<string>;
  getStream(storageKey: string): Promise<fs.ReadStream>;
  delete(storageKey: string): Promise<void>;
}

// Единственная реализация на этом этапе — локальный диск (спека Stage 2
// §7 явно это допускает для MVP). storageKey — всегда randomUUID(),
// никогда не производное от имени файла пользователя: путь на диске не
// зависит от пользовательского ввода вообще, а не просто "проверен" —
// защита от path traversal по конструкции.
@Injectable()
export class LocalFileStorageService implements FileStorage {
  private readonly logger = new Logger(LocalFileStorageService.name);
  private ready: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  // FILE_UPLOAD_DIR — совпадает с volume mount в docker-compose.prod.yml
  // (file_uploads_data:/data/uploads) — без volume файлы терялись бы при
  // каждом пересоздании контейнера api. Дефолт для локальной разработки —
  // просто относительный каталог внутри репозитория.
  private uploadDir(): string {
    return this.config.get<string>('FILE_UPLOAD_DIR') || path.join(process.cwd(), '.uploads');
  }

  private async ensureDir(): Promise<void> {
    if (!this.ready) {
      this.ready = fsPromises.mkdir(this.uploadDir(), { recursive: true }).then(() => undefined);
    }
    await this.ready;
  }

  async save(buffer: Buffer): Promise<string> {
    await this.ensureDir();
    const storageKey = randomUUID();
    await fsPromises.writeFile(path.join(this.uploadDir(), storageKey), buffer);
    return storageKey;
  }

  // Не async — fs.createReadStream синхронно возвращает поток (сам файл
  // читается лениво по мере потребления), await внутри не нужен. Promise-
  // обёртка в сигнатуре остаётся: будущая замена на S3/MinIO здесь
  // реально обратится по сети, а вызывающий код (FilesService) уже готов
  // к асинхронному интерфейсу.
  getStream(storageKey: string): Promise<fs.ReadStream> {
    return Promise.resolve(fs.createReadStream(path.join(this.uploadDir(), storageKey)));
  }

  // Best-effort — тот же принцип, что AuditService.log/
  // GoogleCalendarSyncService.pushBestEffort: отсутствующий на диске файл
  // (например, ручная чистка volume) не должен ронять удаление записи в БД.
  async delete(storageKey: string): Promise<void> {
    try {
      await fsPromises.unlink(path.join(this.uploadDir(), storageKey));
    } catch (err) {
      this.logger.warn(`Не удалось удалить файл ${storageKey} с диска: ${err}`);
    }
  }
}

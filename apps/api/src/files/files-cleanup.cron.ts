import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE, type FileStorage } from './file-storage.service';

const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Phase F.1 (аудит 16.09.2026, находка #10) — файл, загруженный через
// POST /files/upload, но так и не отправленный в сообщении (пользователь
// снял вложение до P1.3, закрыл Mini App, обновил страницу) раньше жил на
// диске и в БД вечно. messageId === null уже однозначно означает
// "не прикреплён" (см. FilesService.deleteUnattached) — отдельную колонку
// status заводить незачем, тот же факт был бы задублирован.
@Injectable()
export class FilesCleanupCron {
  private readonly logger = new Logger(FilesCleanupCron.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupOrphanUploads(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_MAX_AGE_MS);
    const orphans = await this.prisma.fileArtifact.findMany({
      where: { messageId: null, createdAt: { lt: cutoff } },
    });
    for (const file of orphans) {
      // storage.delete уже best-effort (см. LocalFileStorageService) — не
      // мешает удалить строку из БД, даже если физического файла на диске
      // уже не было.
      await this.storage.delete(file.storageKey);
      await this.prisma.fileArtifact.delete({ where: { id: file.id } });
    }
    if (orphans.length > 0) {
      this.logger.log(`Удалено orphan-загрузок: ${orphans.length}`);
    }
  }
}

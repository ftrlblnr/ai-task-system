import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StorageRegistry } from './storage-registry.service';

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
    // StorageRegistry, не напрямую FILE_STORAGE (Stage 2, Phase H.2, аудит
    // 20.09.2026, P2) — каждый orphan удаляется через ТОТ провайдер, что
    // реально его сохранил (file.storageProvider), не через текущее
    // умолчание для новых файлов.
    private readonly registry: StorageRegistry,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupOrphanUploads(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_MAX_AGE_MS);
    const orphans = await this.prisma.fileArtifact.findMany({
      where: { messageId: null, createdAt: { lt: cutoff } },
    });
    let deleted = 0;
    for (const file of orphans) {
      // storage.delete теперь best-effort только для ENOENT (файла и так
      // уже нет — не мешает удалить строку из БД, см.
      // LocalFileStorageService.delete). Любая ДРУГАЯ ошибка диска раньше
      // тоже глоталась там же, и эта строка удаляла FileArtifact из БД
      // безусловно — физический файл оставался на диске, но единственная
      // запись, по которой его можно было бы найти и повторить попытку,
      // уже удалена (внешний аудит 20.09.2026, P1). Теперь настоящая
      // ошибка пробрасывается сюда — не удаляем строку, оставляем на
      // повтор следующим часовым прогоном, продолжаем с остальными файлами
      // в этой же партии (один сбойный файл не должен блокировать чистку
      // остальных).
      try {
        await this.registry.resolve(file.storageProvider).delete(file.storageKey);
      } catch (err) {
        this.logger.error(`Не удалось удалить файл ${file.storageKey} с диска — оставляю запись в БД для повтора: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      await this.prisma.fileArtifact.delete({ where: { id: file.id } });
      deleted++;
    }
    if (deleted > 0) {
      this.logger.log(`Удалено orphan-загрузок: ${deleted}`);
    }
  }
}

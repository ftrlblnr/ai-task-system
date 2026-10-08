import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FileArtifactSource } from '@prisma/client';
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
    // Агент поездок (ТЗ 08.10.2026) — живой баг 08.10.2026: TripMaterial
    // ссылается на FileArtifact тем же приёмом, что и EmailAttachment
    // (простая строка fileArtifactId, не формальная Prisma-связь) и тоже
    // никогда не получает messageId — загрузка материала идёт через
    // FilesService.upload() с source=UPLOADED, тот же источник, что у
    // обычного (действительно орфанного) вложения композера, поэтому
    // исключить весь source целиком, как сделано для почты, здесь нельзя.
    // Без этого исключения материал поездки удалялся бы отсюда же через
    // сутки после загрузки, пока TripMaterial.fileArtifactId продолжал
    // указывать на уже не существующий файл — ровно то, что сломало
    // предпросмотр/скачивание материалов в проде.
    const referenced = await this.prisma.tripMaterial.findMany({ select: { fileArtifactId: true }, distinct: ['fileArtifactId'] });
    const referencedIds = referenced.map((m) => m.fileArtifactId);
    const orphans = await this.prisma.fileArtifact.findMany({
      // Release 2 (Mail.ru Email Intelligence) — вложения почты
      // (FileArtifactSource.INTERNAL) тоже имеют messageId === null (они
      // привязаны через EmailAttachment.fileArtifactId, другую связь, а не
      // через Message), но НЕ являются "непрокреплёнными загрузками
      // чата" — без этого исключения синхронное вложение удалялось бы
      // отсюда же через сутки после синка, а EmailAttachment.fileArtifactId
      // тихо повисал бы на несуществующий файл.
      where: {
        messageId: null,
        createdAt: { lt: cutoff },
        source: { not: FileArtifactSource.INTERNAL },
        ...(referencedIds.length > 0 ? { id: { notIn: referencedIds } } : {}),
      },
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

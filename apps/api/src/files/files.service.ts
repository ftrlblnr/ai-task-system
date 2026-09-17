import type { Readable } from 'stream';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FileArtifact, FileArtifactSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { FILE_STORAGE, type FileStorage } from './file-storage.service';
import { isSuspiciousUpload, extensionMatchesMimeType } from './file-signature';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_FILE_SIZE } from './dto/upload-file.dto';

// Только для отображения (FileArtifact.name) — путь на диске никогда не
// зависит от имени файла пользователя (см. file-storage.service.ts,
// storageKey всегда randomUUID()), это чистка от управляющих символов и
// разумный потолок длины, не защита от path traversal (та уже есть по
// конструкции).
function sanitizeFileName(name: string): string {
  // Фильтр по code point, не регэксп с литеральными управляющими символами
  // (\x00-\x1f) — эта же чистка регэкспом ловит no-control-regex, хотя
  // намерение здесь ровно то, на что жалуется правило: реальный фильтр
  // управляющих символов, не случайная опечатка.
  const cleaned = Array.from(name)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim();
  return cleaned.slice(0, 200) || 'file';
}

// Stage 2, Phase F — вложения в чат. FileArtifact заведён ещё в Phase A
// (задел под эту фазу и будущую Phase G — генерируемые файлы), здесь
// впервые появляется код, который её реально наполняет. Phase F.1
// (аудит 16.09.2026) — magic-byte проверка + DELETE для непривязанных
// файлов + инъекция через FILE_STORAGE-токен (не конкретный класс).
// Phase F.2 (аудит 17.09.2026) — size/MIME-allowlist раньше проверялись
// только на уровне FileInterceptor в контроллере (limits/fileFilter):
// прямой вызов upload() в обход HTTP мог обойти обе проверки. Сервис
// теперь сам гарантирует size/MIME/extension↔MIME/MIME↔сигнатура —
// controller-проверка остаётся как быстрый first-pass фильтр до чтения
// буфера в память, не единственная линия защиты.
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async upload(user: AuthenticatedUser, buffer: Buffer, originalName: string, mimeType: string): Promise<FileArtifact> {
    if (buffer.length > MAX_UPLOAD_FILE_SIZE) {
      throw new BadRequestException('Файл превышает допустимый размер');
    }
    if (!ALLOWED_UPLOAD_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException('Недопустимый тип файла');
    }
    if (!extensionMatchesMimeType(originalName, mimeType)) {
      throw new BadRequestException('Расширение файла не соответствует заявленному типу');
    }
    // Client-declared MIME (уже прошедший allowlist выше) сверяется с
    // реальными байтами — see file-signature.ts про то, что именно и
    // почему проверяется/не проверяется.
    if (isSuspiciousUpload(buffer, mimeType)) {
      throw new BadRequestException('Файл не прошёл проверку типа — содержимое не соответствует заявленному формату');
    }
    return this.persist(user, buffer, sanitizeFileName(originalName), mimeType, FileArtifactSource.UPLOADED);
  }

  // Stage 2, Phase G — файл, сформированный самим сервером (например,
  // export_tasks_xlsx, apps/api/src/assistant/task-export.ts), а не
  // присланный пользователем. isSuspiciousUpload здесь намеренно не
  // вызывается — та проверка защищает от байтов, присланных пользователем
  // и не совпадающих с заявленным типом; здесь байты формирует сам сервер
  // (exceljs), сверять их с собой же нет смысла.
  async createGenerated(user: AuthenticatedUser, buffer: Buffer, name: string, mimeType: string): Promise<FileArtifact> {
    return this.persist(user, buffer, sanitizeFileName(name), mimeType, FileArtifactSource.GENERATED);
  }

  // Phase F.2 (аудит 17.09.2026, P0 — storage/DB consistency) — раньше
  // storage.save() и prisma.fileArtifact.create() не были ничем связаны:
  // сбой БД после успешной записи на диск оставлял физический файл без
  // единой ссылающейся на него записи, cleanup cron его не видит (он
  // ищет orphan-записи в БД, не orphan-файлы на диске). Компенсирующее
  // удаление при сбое create() возвращает систему в состояние "как будто
  // upload не начинался". Если само компенсирующее удаление тоже падает —
  // обе ошибки логируются, наружу уходит исходная ошибка операции (сбой
  // БД важнее для вызывающего кода, чем то, что чистка не удалась).
  private async persist(
    user: AuthenticatedUser,
    buffer: Buffer,
    name: string,
    mimeType: string,
    source: FileArtifactSource,
  ): Promise<FileArtifact> {
    const storageKey = await this.storage.save(buffer);
    try {
      return await this.prisma.fileArtifact.create({
        data: {
          employeeId: user.id,
          name,
          mimeType,
          size: buffer.length,
          storageProvider: this.storage.provider,
          storageKey,
          source,
        },
      });
    } catch (err) {
      this.logger.error(`fileArtifact.create failed after storage.save (storageKey=${storageKey}): ${err instanceof Error ? err.message : err}`);
      try {
        await this.storage.delete(storageKey);
      } catch (cleanupErr) {
        this.logger.error(`compensation delete failed for storageKey=${storageKey}: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`);
      }
      throw err;
    }
  }

  // 404, не 403 — тот же принцип, что AssistantChatService.
  // findOwnedConversation: чужому сотруднику не подтверждаем даже факт
  // существования чужого файла (спека §30 — fileId в руках клиента не
  // равно праву на файл).
  async assertOwnedFile(user: AuthenticatedUser, fileId: string): Promise<FileArtifact> {
    const file = await this.prisma.fileArtifact.findUnique({ where: { id: fileId } });
    if (!file || file.employeeId !== user.id) {
      throw new NotFoundException('Файл не найден');
    }
    return file;
  }

  // Readable, не общий NodeJS.ReadableStream — StreamableFile
  // (@nestjs/common) принимает конкретно Readable/Uint8Array, а не любой
  // объект с методом read(); генерализация до NodeJS.ReadableStream стоила
  // настоящей ошибки компиляции (TS2769, поймано в CI). Readable — тот же
  // базовый класс, которому уже наследует fs.ReadStream, поэтому
  // LocalFileStorageService.getStream не меняется.
  async getDownloadStream(user: AuthenticatedUser, fileId: string): Promise<{ stream: Readable; file: FileArtifact }> {
    const file = await this.assertOwnedFile(user, fileId);
    const stream = await this.storage.getStream(file.storageKey);
    return { stream, file };
  }

  // Phase F.1 (аудит 16.09.2026, находка #10 "orphan uploads") — раньше
  // снятие вложения крестиком в composer'е убирало его только из
  // локального React state, физический файл и FileArtifact оставались
  // навсегда. messageId === null — "прикреплён" однозначно кодируется
  // самим этим полем (не заводим отдельную колонку status ради того же
  // факта, который уже виден). Прикреплённый файл удалить нельзя — он уже
  // виден в отправленном сообщении, удаление задним числом сломало бы
  // историю переписки.
  async deleteUnattached(user: AuthenticatedUser, fileId: string): Promise<void> {
    const file = await this.assertOwnedFile(user, fileId);
    if (file.messageId) {
      throw new BadRequestException('Нельзя удалить файл, уже прикреплённый к отправленному сообщению');
    }
    await this.storage.delete(file.storageKey);
    await this.prisma.fileArtifact.delete({ where: { id: file.id } });
  }
}

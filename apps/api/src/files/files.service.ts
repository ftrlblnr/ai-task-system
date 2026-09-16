import type { ReadStream } from 'fs';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { FileArtifact, FileArtifactSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { FILE_STORAGE, type FileStorage } from './file-storage.service';
import { isSuspiciousUpload } from './file-signature';

const STORAGE_PROVIDER = 'local';

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
@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async upload(user: AuthenticatedUser, buffer: Buffer, originalName: string, mimeType: string): Promise<FileArtifact> {
    // Client-declared MIME (уже прошедший allowlist в fileFilter
    // контроллера) сверяется с реальными байтами — see file-signature.ts
    // про то, что именно и почему проверяется/не проверяется.
    if (isSuspiciousUpload(buffer, mimeType)) {
      throw new BadRequestException('Файл не прошёл проверку типа — содержимое не соответствует заявленному формату');
    }
    const storageKey = await this.storage.save(buffer);
    return this.prisma.fileArtifact.create({
      data: {
        employeeId: user.id,
        name: sanitizeFileName(originalName),
        mimeType,
        size: buffer.length,
        storageProvider: STORAGE_PROVIDER,
        storageKey,
        source: FileArtifactSource.UPLOADED,
      },
    });
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

  // fs.ReadStream, не общий NodeJS.ReadableStream — StreamableFile
  // (@nestjs/common) принимает конкретно Readable/Uint8Array, а не любой
  // объект с методом read(); генерализация здесь стоила настоящей ошибки
  // компиляции (TS2769, поймано в CI, локальный nest build на этой сессии
  // не успевал прогнаться до конца из-за памяти VPS).
  async getDownloadStream(user: AuthenticatedUser, fileId: string): Promise<{ stream: ReadStream; file: FileArtifact }> {
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

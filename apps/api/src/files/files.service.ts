import { Injectable, NotFoundException } from '@nestjs/common';
import { FileArtifact, FileArtifactSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { LocalFileStorageService } from './file-storage.service';

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
// впервые появляется код, который её реально наполняет.
@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalFileStorageService,
  ) {}

  async upload(user: AuthenticatedUser, buffer: Buffer, originalName: string, mimeType: string): Promise<FileArtifact> {
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

  async getDownloadStream(user: AuthenticatedUser, fileId: string): Promise<{ stream: NodeJS.ReadableStream; file: FileArtifact }> {
    const file = await this.assertOwnedFile(user, fileId);
    const stream = await this.storage.getStream(file.storageKey);
    return { stream, file };
  }
}

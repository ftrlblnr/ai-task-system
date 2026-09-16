import { BadRequestException, Controller, Delete, Get, Param, Post, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { FilesService } from './files.service';
import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_FILE_SIZE } from './dto/upload-file.dto';

// Content-Disposition с не-ASCII именем (кириллица — обычный случай в
// этом проекте) — classic filename="" ломается на не-ASCII, RFC 5987
// filename*=UTF-8''... рядом с ASCII-фолбэком — то же самое расширение,
// каким уже сегодня пользуются браузеры/curl.
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// Busboy/Multer декодируют имя файла из multipart-заголовка как latin1
// (исторический дефолт HTTP multipart, RFC 7578 не требует UTF-8) — не-
// ASCII имя (кириллица — обычный случай в этом проекте) приходит в
// originalname искажённым (каждый UTF-8 байт интерпретирован как отдельный
// latin1-символ). Обратное перекодирование latin1→utf8 — стандартный
// обходной путь для этого известного поведения Busboy, а не специфика
// этого проекта (найдено 16.09.2026 живым тестом с реальным кириллическим
// именем файла — "Отчёт.txt" превращалось в мусор без этой строки).
function fixMultipartFileName(originalName: string): string {
  return Buffer.from(originalName, 'latin1').toString('utf8');
}

// Без @Roles(...) — как VoiceController/AssistantChatController: вложения
// доступны любому сотруднику, владение конкретным файлом проверяется в
// сервисе (assertOwnedFile), не ролью.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_UPLOAD_FILE_SIZE },
      fileFilter: (_req, file, cb) => {
        cb(null, ALLOWED_UPLOAD_MIME_TYPES.includes(file.mimetype));
      },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    // fileFilter отклоняет неподдерживаемый MIME через cb(null, false) —
    // файл молча не попадает в запрос, а не кидает ошибку (тот же паттерн,
    // что voice.controller.ts) — проверяем и бросаем понятную ошибку здесь.
    if (!file) {
      throw new BadRequestException('Файл не получен, формат не поддерживается или превышен размер');
    }
    const artifact = await this.files.upload(user, file.buffer, fixMultipartFileName(file.originalname), file.mimetype);
    return { fileId: artifact.id, name: artifact.name, mimeType: artifact.mimeType, size: artifact.size };
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<StreamableFile> {
    const { stream, file } = await this.files.getDownloadStream(user, id);
    return new StreamableFile(stream, { type: file.mimeType, disposition: contentDisposition(file.name) });
  }

  // Phase F.1 (аудит 16.09.2026, находка #10) — снятие вложения в
  // composer'е (Mini App) до этого только убирало его из локального
  // React state, физический файл и запись оставались навсегда ("orphan
  // upload"). Владение и "ещё не прикреплён" проверяются в
  // FilesService.deleteUnattached.
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<{ ok: true }> {
    await this.files.deleteUnattached(user, id);
    return { ok: true };
  }
}

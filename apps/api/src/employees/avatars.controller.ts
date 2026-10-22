import { BadRequestException, Controller, Delete, Get, HttpCode, HttpStatus, Param, Put, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AVATAR_MIME_TYPES, AvatarService, MAX_AVATAR_BYTES } from './avatar.service';

@Controller()
export class AvatarsController {
  constructor(private readonly avatars: AvatarService) {}

  // Своё фото — любой сотрудник.
  @Put('me/avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_AVATAR_BYTES },
      fileFilter: (_req, file, cb) => cb(null, AVATAR_MIME_TYPES.includes(file.mimetype)),
    }),
  )
  setMine(@UploadedFile() file: Express.Multer.File | undefined, @CurrentUser() user: AuthenticatedUser) {
    if (!file) throw new BadRequestException('Нужна картинка JPEG, PNG или WebP до 1 МБ');
    return this.avatars.set(user.id, file.buffer, file.mimetype);
  }

  @Delete('me/avatar')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMine(@CurrentUser() user: AuthenticatedUser) {
    await this.avatars.remove(user.id);
  }

  @Get('avatars')
  @UseGuards(JwtAuthGuard)
  map() {
    return this.avatars.map();
  }

  // Без JWT: <img src> не отправляет Bearer-заголовок. Key — 128 случайных
  // бит и меняется с каждой загрузкой, поэтому кэш «навсегда».
  @Get('avatars/:key')
  async image(@Param('key') key: string, @Res() res: Response) {
    const { data, mimeType } = await this.avatars.get(key);
    res.set({
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.send(data);
  }
}

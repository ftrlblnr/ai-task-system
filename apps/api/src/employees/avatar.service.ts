import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { isSuspiciousUpload } from '../files/file-signature';

// Аватар сотрудника (владелец 22.10.2026). Клиент сам обрезает фото до
// квадрата и уменьшает до 256×256, сюда приходит готовая картинка.
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_AVATAR_BYTES = 1024 * 1024;

export function avatarPath(key: string): string {
  return `/avatars/${key}`;
}

@Injectable()
export class AvatarService {
  constructor(private readonly prisma: PrismaService) {}

  async set(employeeId: string, buffer: Buffer, mimeType: string): Promise<{ photoUrl: string }> {
    if (!AVATAR_MIME_TYPES.includes(mimeType) || buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) {
      throw new BadRequestException('Нужна картинка JPEG, PNG или WebP до 1 МБ');
    }
    if (isSuspiciousUpload(buffer, mimeType)) throw new BadRequestException('Файл не похож на картинку');

    const key = randomBytes(16).toString('hex');
    const photoUrl = avatarPath(key);
    await this.prisma.$transaction([
      this.prisma.employeeAvatar.deleteMany({ where: { employeeId } }),
      this.prisma.employeeAvatar.create({ data: { key, employeeId, mimeType, data: new Uint8Array(buffer) } }),
      this.prisma.employee.update({ where: { id: employeeId }, data: { photoUrl } }),
    ]);
    return { photoUrl };
  }

  async remove(employeeId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.employeeAvatar.deleteMany({ where: { employeeId } }),
      this.prisma.employee.update({ where: { id: employeeId }, data: { photoUrl: null } }),
    ]);
  }

  // Карта «сотрудник → путь к фото» для всех, у кого фото есть: клиент
  // грузит её один раз и подставляет фото в любой <Avatar> по id.
  async map(): Promise<Record<string, string>> {
    const rows = await this.prisma.employee.findMany({ where: { photoUrl: { not: null } }, select: { id: true, photoUrl: true } });
    return Object.fromEntries(rows.map((r) => [r.id, r.photoUrl!]));
  }

  async get(key: string): Promise<{ data: Buffer; mimeType: string }> {
    const avatar = await this.prisma.employeeAvatar.findUnique({ where: { key }, select: { data: true, mimeType: true } });
    if (!avatar) throw new NotFoundException();
    return { data: Buffer.from(avatar.data), mimeType: avatar.mimeType };
  }
}

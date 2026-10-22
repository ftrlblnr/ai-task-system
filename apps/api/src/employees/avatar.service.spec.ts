import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AvatarService } from './avatar.service';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function make() {
  const prisma = {
    $transaction: jest.fn().mockResolvedValue([]),
    employeeAvatar: { deleteMany: jest.fn(), create: jest.fn(), findUnique: jest.fn() },
    employee: { update: jest.fn(), findMany: jest.fn() },
  };
  return { service: new AvatarService(prisma as never), prisma };
}

describe('AvatarService', () => {
  it('set: новый случайный key, старое фото заменяется, путь — в photoUrl', async () => {
    const { service, prisma } = make();
    const { photoUrl } = await service.set('u1', PNG, 'image/png');
    expect(photoUrl).toMatch(/^\/avatars\/[0-9a-f]{32}$/);
    expect(prisma.employeeAvatar.deleteMany).toHaveBeenCalledWith({ where: { employeeId: 'u1' } });
    expect(prisma.employeeAvatar.create).toHaveBeenCalledWith({ data: expect.objectContaining({ employeeId: 'u1', mimeType: 'image/png', key: photoUrl.slice(9) }) });
    expect(prisma.employee.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { photoUrl } });
    const second = await service.set('u1', PNG, 'image/png');
    expect(second.photoUrl).not.toBe(photoUrl);
  });

  it('set: не картинка, чужой тип или слишком большой файл — 400', async () => {
    const { service } = make();
    await expect(service.set('u1', Buffer.from('<html>'), 'image/png')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.set('u1', PNG, 'image/svg+xml')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.set('u1', Buffer.alloc(2 * 1024 * 1024), 'image/png')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('map и get', async () => {
    const { service, prisma } = make();
    prisma.employee.findMany.mockResolvedValue([{ id: 'u1', photoUrl: '/avatars/k1' }]);
    expect(await service.map()).toEqual({ u1: '/avatars/k1' });
    prisma.employeeAvatar.findUnique.mockResolvedValue(null);
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

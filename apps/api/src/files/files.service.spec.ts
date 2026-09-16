import { NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { FilesService } from './files.service';

// Stage 2, Phase F — assertOwnedFile — тот же принцип, что
// AssistantChatService.findOwnedConversation (404, не 403 — не
// подтверждаем чужому пользователю сам факт существования файла, спека §30).
function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, isProfileAdmin: false, ...overrides };
}

describe('FilesService.assertOwnedFile', () => {
  it('бросает NotFoundException для файла другого сотрудника', async () => {
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', employeeId: 'someone-else' }) } };
    const service = new FilesService(prisma as any, {} as any);
    await expect(service.assertOwnedFile(user(), 'f1')).rejects.toThrow(NotFoundException);
  });

  it('бросает NotFoundException для несуществующего файла', async () => {
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new FilesService(prisma as any, {} as any);
    await expect(service.assertOwnedFile(user(), 'ghost')).rejects.toThrow(NotFoundException);
  });

  it('возвращает файл его владельцу', async () => {
    const file = { id: 'f1', employeeId: 'u1' };
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file) } };
    const service = new FilesService(prisma as any, {} as any);
    await expect(service.assertOwnedFile(user(), 'f1')).resolves.toBe(file);
  });
});

describe('FilesService.getDownloadStream', () => {
  it('отдаёт поток только владельцу файла', async () => {
    const file = { id: 'f1', employeeId: 'u1', storageKey: 'key-1' };
    const stream = {};
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file) } };
    const storage = { getStream: jest.fn().mockResolvedValue(stream) };
    const service = new FilesService(prisma as any, storage as any);

    const result = await service.getDownloadStream(user(), 'f1');

    expect(storage.getStream).toHaveBeenCalledWith('key-1');
    expect(result).toEqual({ stream, file });
  });

  it('чужому сотруднику — NotFoundException, storage.getStream не вызывается', async () => {
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', employeeId: 'someone-else' }) } };
    const storage = { getStream: jest.fn() };
    const service = new FilesService(prisma as any, storage as any);

    await expect(service.getDownloadStream(user(), 'f1')).rejects.toThrow(NotFoundException);
    expect(storage.getStream).not.toHaveBeenCalled();
  });
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
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

describe('FilesService.upload (Stage 2 Phase F.1 — magic-byte проверка)', () => {
  it('отклоняет файл, чьи байты не совпадают с заявленным MIME (spoofed)', async () => {
    const prisma = { fileArtifact: { create: jest.fn() } };
    const storage = { save: jest.fn() };
    const service = new FilesService(prisma as any, storage as any);
    const pdfBytesDeclaredAsPng = Buffer.from('%PDF-1.4\n...');

    await expect(service.upload(user(), pdfBytesDeclaredAsPng, 'x.png', 'image/png')).rejects.toThrow(BadRequestException);
    expect(storage.save).not.toHaveBeenCalled();
    expect(prisma.fileArtifact.create).not.toHaveBeenCalled();
  });

  it('сохраняет файл, чьи байты соответствуют заявленному MIME', async () => {
    const created = { id: 'f1' };
    const prisma = { fileArtifact: { create: jest.fn().mockResolvedValue(created) } };
    const storage = { save: jest.fn().mockResolvedValue('key-1') };
    const service = new FilesService(prisma as any, storage as any);
    const realPdf = Buffer.from('%PDF-1.4\n...');

    const result = await service.upload(user(), realPdf, 'x.pdf', 'application/pdf');

    expect(storage.save).toHaveBeenCalledWith(realPdf);
    expect(result).toBe(created);
  });
});

describe('FilesService.deleteUnattached (Stage 2 Phase F.1, аудит находка #10 — orphan uploads)', () => {
  it('удаляет непривязанный файл владельца — с диска и из БД', async () => {
    const file = { id: 'f1', employeeId: 'u1', messageId: null, storageKey: 'key-1' };
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file), delete: jest.fn() } };
    const storage = { delete: jest.fn() };
    const service = new FilesService(prisma as any, storage as any);

    await service.deleteUnattached(user(), 'f1');

    expect(storage.delete).toHaveBeenCalledWith('key-1');
    expect(prisma.fileArtifact.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });
  });

  it('отказывает в удалении уже прикреплённого файла', async () => {
    const file = { id: 'f1', employeeId: 'u1', messageId: 'm1', storageKey: 'key-1' };
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file), delete: jest.fn() } };
    const storage = { delete: jest.fn() };
    const service = new FilesService(prisma as any, storage as any);

    await expect(service.deleteUnattached(user(), 'f1')).rejects.toThrow(BadRequestException);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(prisma.fileArtifact.delete).not.toHaveBeenCalled();
  });

  it('чужой файл — NotFoundException, ничего не удаляется', async () => {
    const file = { id: 'f1', employeeId: 'someone-else', messageId: null, storageKey: 'key-1' };
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file), delete: jest.fn() } };
    const storage = { delete: jest.fn() };
    const service = new FilesService(prisma as any, storage as any);

    await expect(service.deleteUnattached(user(), 'f1')).rejects.toThrow(NotFoundException);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { FilesService } from './files.service';
import { MAX_UPLOAD_FILE_SIZE } from './dto/upload-file.dto';

function localStorage(overrides: Record<string, unknown> = {}) {
  return { provider: 'local', save: jest.fn(), getStream: jest.fn(), delete: jest.fn(), ...overrides };
}

// StorageRegistry (Stage 2, Phase H.2, P2) — getDownloadStream/
// deleteUnattached резолвят провайдер по file.storageProvider, не берут
// this.storage напрямую. Существующие тесты не варьируют storageProvider —
// registry.resolve(...) всегда возвращает тот же storage-мок, что и раньше
// читался напрямую (поведение для этих тестов не меняется).
function registryFor(storage: unknown) {
  return { resolve: jest.fn().mockReturnValue(storage) };
}

// Stage 2, Phase F — assertOwnedFile — тот же принцип, что
// AssistantChatService.findOwnedConversation (404, не 403 — не
// подтверждаем чужому пользователю сам факт существования файла, спека §30).
function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, isProfileAdmin: false, ...overrides };
}

describe('FilesService.assertOwnedFile', () => {
  it('бросает NotFoundException для файла другого сотрудника', async () => {
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', employeeId: 'someone-else' }) } };
    const service = new FilesService(prisma as any, {} as any, {} as any);
    await expect(service.assertOwnedFile(user(), 'f1')).rejects.toThrow(NotFoundException);
  });

  it('бросает NotFoundException для несуществующего файла', async () => {
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new FilesService(prisma as any, {} as any, {} as any);
    await expect(service.assertOwnedFile(user(), 'ghost')).rejects.toThrow(NotFoundException);
  });

  it('возвращает файл его владельцу', async () => {
    const file = { id: 'f1', employeeId: 'u1' };
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file) } };
    const service = new FilesService(prisma as any, {} as any, {} as any);
    await expect(service.assertOwnedFile(user(), 'f1')).resolves.toBe(file);
  });
});

describe('FilesService.getDownloadStream', () => {
  it('отдаёт поток только владельцу файла, резолвит provider по file.storageProvider, не по текущему умолчанию', async () => {
    // storageProvider намеренно 's3-legacy', не 'local' — доказывает, что
    // резолвится ИМЕННО провайдер этого файла (Stage 2, Phase H.2, P2), а
    // не тот, что сейчас настроен для новых загрузок.
    const file = { id: 'f1', employeeId: 'u1', storageKey: 'key-1', storageProvider: 's3-legacy' };
    const stream = {};
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file) } };
    const legacyStorage = { getStream: jest.fn().mockResolvedValue(stream) };
    const registry = { resolve: jest.fn().mockReturnValue(legacyStorage) };
    const service = new FilesService(prisma as any, {} as any, registry as any);

    const result = await service.getDownloadStream(user(), 'f1');

    expect(registry.resolve).toHaveBeenCalledWith('s3-legacy');
    expect(legacyStorage.getStream).toHaveBeenCalledWith('key-1');
    expect(result).toEqual({ stream, file });
  });

  it('чужому сотруднику — NotFoundException, storage.getStream не вызывается', async () => {
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', employeeId: 'someone-else' }) } };
    const storage = { getStream: jest.fn() };
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);

    await expect(service.getDownloadStream(user(), 'f1')).rejects.toThrow(NotFoundException);
    expect(storage.getStream).not.toHaveBeenCalled();
  });
});

describe('FilesService.upload (Stage 2 Phase F.1 — magic-byte проверка)', () => {
  it('отклоняет файл, чьи байты не совпадают с заявленным MIME (spoofed)', async () => {
    const prisma = { fileArtifact: { create: jest.fn() } };
    const storage = localStorage();
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);
    const pdfBytesDeclaredAsPng = Buffer.from('%PDF-1.4\n...');

    await expect(service.upload(user(), pdfBytesDeclaredAsPng, 'x.png', 'image/png')).rejects.toThrow(BadRequestException);
    expect(storage.save).not.toHaveBeenCalled();
    expect(prisma.fileArtifact.create).not.toHaveBeenCalled();
  });

  it('сохраняет файл, чьи байты соответствуют заявленному MIME, storageProvider берётся из storage.provider', async () => {
    const created = { id: 'f1' };
    const prisma = { fileArtifact: { create: jest.fn().mockResolvedValue(created) } };
    const storage = localStorage({ save: jest.fn().mockResolvedValue('key-1') });
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);
    const realPdf = Buffer.from('%PDF-1.4\n...');

    const result = await service.upload(user(), realPdf, 'x.pdf', 'application/pdf');

    expect(storage.save).toHaveBeenCalledWith(realPdf);
    expect(prisma.fileArtifact.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ storageProvider: 'local' }) }));
    expect(result).toBe(created);
  });
});

// Stage 2, Phase F.2 (аудит 17.09.2026, P0.2) — эти проверки раньше жили
// только в FileInterceptor контроллера (limits/fileFilter); прямой вызов
// FilesService.upload (в обход HTTP) обходил их полностью.
describe('FilesService.upload (Stage 2 Phase F.2 — валидация внутри сервиса, не только на контроллере)', () => {
  it('oversized-файл отклоняется', async () => {
    const prisma = { fileArtifact: { create: jest.fn() } };
    const storage = localStorage();
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);
    const oversized = Buffer.alloc(MAX_UPLOAD_FILE_SIZE + 1);

    await expect(service.upload(user(), oversized, 'big.pdf', 'application/pdf')).rejects.toThrow(BadRequestException);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('запрещённый MIME (не в allowlist) отклоняется даже при прямом вызове сервиса', async () => {
    const prisma = { fileArtifact: { create: jest.fn() } };
    const storage = localStorage();
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);

    await expect(service.upload(user(), Buffer.from('data'), 'x.zip', 'application/zip')).rejects.toThrow(BadRequestException);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('расширение не соответствует заявленному MIME — отклонено (например .exe с application/pdf)', async () => {
    const prisma = { fileArtifact: { create: jest.fn() } };
    const storage = localStorage();
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);
    const realPdf = Buffer.from('%PDF-1.4\n...');

    await expect(service.upload(user(), realPdf, 'wow.exe', 'application/pdf')).rejects.toThrow(BadRequestException);
    expect(storage.save).not.toHaveBeenCalled();
  });
});

// Stage 2, Phase F.2 (аудит 17.09.2026, P0.3) — storage/DB consistency.
describe('FilesService — компенсация при storage success + DB failure', () => {
  it('upload: DB-сбой после storage.save() вызывает storage.delete(), исходная ошибка пробрасывается', async () => {
    const dbError = new Error('db unreachable');
    const prisma = { fileArtifact: { create: jest.fn().mockRejectedValue(dbError) } };
    const storage = localStorage({ save: jest.fn().mockResolvedValue('key-1') });
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);
    const realPdf = Buffer.from('%PDF-1.4\n...');

    await expect(service.upload(user(), realPdf, 'x.pdf', 'application/pdf')).rejects.toThrow(dbError);
    expect(storage.delete).toHaveBeenCalledWith('key-1');
  });

  it('createGenerated: та же компенсация, что и upload (одна и та же гарантия для сгенерированных файлов)', async () => {
    const dbError = new Error('db unreachable');
    const prisma = { fileArtifact: { create: jest.fn().mockRejectedValue(dbError) } };
    const storage = localStorage({ save: jest.fn().mockResolvedValue('key-2') });
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);

    await expect(service.createGenerated(user(), Buffer.from('xlsx bytes'), 'x.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).rejects.toThrow(dbError);
    expect(storage.delete).toHaveBeenCalledWith('key-2');
  });

  it('если само компенсирующее удаление тоже падает — наружу всё равно летит исходная ошибка DB, обе ошибки логируются отдельно', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const dbError = new Error('db unreachable');
    const cleanupError = new Error('disk unavailable');
    const prisma = { fileArtifact: { create: jest.fn().mockRejectedValue(dbError) } };
    const storage = localStorage({ save: jest.fn().mockResolvedValue('key-3'), delete: jest.fn().mockRejectedValue(cleanupError) });
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);

    await expect(service.upload(user(), Buffer.from('%PDF-1.4\n...'), 'x.pdf', 'application/pdf')).rejects.toThrow(dbError);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('db unreachable'))).toBe(true);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('disk unavailable'))).toBe(true);
    errorSpy.mockRestore();
  });
});

describe('FilesService.createGenerated (Stage 2, Phase G — файлы, сформированные инструментом, не пользователем)', () => {
  it('сохраняет файл с source: GENERATED, без magic-byte проверки', async () => {
    const created = { id: 'f1', name: 'Задачи (все) 2026-09-16.xlsx' };
    const prisma = { fileArtifact: { create: jest.fn().mockResolvedValue(created) } };
    const storage = { save: jest.fn().mockResolvedValue('key-1') };
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);
    // Настоящие .xlsx-байты не начинаются с сигнатуры, которую file-signature.ts
    // проверял бы как "похоже на исполняемый файл" — если бы magic-byte
    // проверка здесь ошибочно вызывалась, эти байты (не PK\x03\x04) её бы
    // не прошли, и upload() отклонил бы их (см. isSuspiciousUpload).
    const buffer = Buffer.from('не zip и не exe, просто байты');

    const result = await service.createGenerated(user(), buffer, 'Задачи (все) 2026-09-16.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    expect(storage.save).toHaveBeenCalledWith(buffer);
    expect(prisma.fileArtifact.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: 'GENERATED', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) }),
    );
    expect(result).toBe(created);
  });
});

describe('FilesService.deleteUnattached (Stage 2 Phase F.1, аудит находка #10 — orphan uploads)', () => {
  it('удаляет непривязанный файл владельца — с диска и из БД', async () => {
    const file = { id: 'f1', employeeId: 'u1', messageId: null, storageKey: 'key-1' };
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file), delete: jest.fn() } };
    const storage = { delete: jest.fn() };
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);

    await service.deleteUnattached(user(), 'f1');

    expect(storage.delete).toHaveBeenCalledWith('key-1');
    expect(prisma.fileArtifact.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });
  });

  it('отказывает в удалении уже прикреплённого файла', async () => {
    const file = { id: 'f1', employeeId: 'u1', messageId: 'm1', storageKey: 'key-1' };
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file), delete: jest.fn() } };
    const storage = { delete: jest.fn() };
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);

    await expect(service.deleteUnattached(user(), 'f1')).rejects.toThrow(BadRequestException);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(prisma.fileArtifact.delete).not.toHaveBeenCalled();
  });

  it('чужой файл — NotFoundException, ничего не удаляется', async () => {
    const file = { id: 'f1', employeeId: 'someone-else', messageId: null, storageKey: 'key-1' };
    const prisma = { fileArtifact: { findUnique: jest.fn().mockResolvedValue(file), delete: jest.fn() } };
    const storage = { delete: jest.fn() };
    const service = new FilesService(prisma as any, storage as any, registryFor(storage) as any);

    await expect(service.deleteUnattached(user(), 'f1')).rejects.toThrow(NotFoundException);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

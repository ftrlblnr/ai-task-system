import { FilesCleanupCron } from './files-cleanup.cron';

// Stage 2, Phase F.1 (аудит 16.09.2026, находка #10) — только messageId:null
// старше суток удаляются, привязанные файлы крон не трогает вообще (сам
// запрос к БД это гарантирует — здесь проверяем, что найденные orphan'ы
// реально удаляются и с диска, и из БД).
describe('FilesCleanupCron.cleanupOrphanUploads', () => {
  it('удаляет физический файл и запись для каждого orphan-файла', async () => {
    const orphan1 = { id: 'f1', storageKey: 'key-1', messageId: null, createdAt: new Date('2020-01-01') };
    const orphan2 = { id: 'f2', storageKey: 'key-2', messageId: null, createdAt: new Date('2020-01-01') };
    const prisma = {
      fileArtifact: {
        findMany: jest.fn().mockResolvedValue([orphan1, orphan2]),
        delete: jest.fn(),
      },
    };
    const storage = { delete: jest.fn() };
    const cron = new FilesCleanupCron(prisma as any, storage as any);

    await cron.cleanupOrphanUploads();

    expect(storage.delete).toHaveBeenCalledWith('key-1');
    expect(storage.delete).toHaveBeenCalledWith('key-2');
    expect(prisma.fileArtifact.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });
    expect(prisma.fileArtifact.delete).toHaveBeenCalledWith({ where: { id: 'f2' } });
  });

  it('запрос к БД фильтрует по messageId:null и возрасту — сам крон не решает, что orphan, а что нет', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { fileArtifact: { findMany, delete: jest.fn() } };
    const storage = { delete: jest.fn() };
    const cron = new FilesCleanupCron(prisma as any, storage as any);

    await cron.cleanupOrphanUploads();

    expect(findMany).toHaveBeenCalledWith({
      where: { messageId: null, createdAt: { lt: expect.any(Date) } },
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });
});

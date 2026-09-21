import { FilesCleanupCron } from './files-cleanup.cron';

// StorageRegistry (Stage 2, Phase H.2, P2) — крон резолвит провайдер по
// file.storageProvider, не берёт FILE_STORAGE напрямую; для этих тестов
// (один provider) registry.resolve(...) всегда возвращает тот же
// storage-мок.
function registryFor(storage: unknown) {
  return { resolve: jest.fn().mockReturnValue(storage) };
}

// Stage 2, Phase F.1 (аудит 16.09.2026, находка #10) — только messageId:null
// старше суток удаляются, привязанные файлы крон не трогает вообще (сам
// запрос к БД это гарантирует — здесь проверяем, что найденные orphan'ы
// реально удаляются и с диска, и из БД).
describe('FilesCleanupCron.cleanupOrphanUploads', () => {
  it('удаляет физический файл и запись для каждого orphan-файла, резолвит provider по file.storageProvider', async () => {
    const orphan1 = { id: 'f1', storageKey: 'key-1', storageProvider: 'local', messageId: null, createdAt: new Date('2020-01-01') };
    const orphan2 = { id: 'f2', storageKey: 'key-2', storageProvider: 'local', messageId: null, createdAt: new Date('2020-01-01') };
    const prisma = {
      fileArtifact: {
        findMany: jest.fn().mockResolvedValue([orphan1, orphan2]),
        delete: jest.fn(),
      },
    };
    const storage = { delete: jest.fn() };
    const registry = registryFor(storage);
    const cron = new FilesCleanupCron(prisma as any, registry as any);

    await cron.cleanupOrphanUploads();

    expect(registry.resolve).toHaveBeenCalledWith('local');

    expect(storage.delete).toHaveBeenCalledWith('key-1');
    expect(storage.delete).toHaveBeenCalledWith('key-2');
    expect(prisma.fileArtifact.delete).toHaveBeenCalledWith({ where: { id: 'f1' } });
    expect(prisma.fileArtifact.delete).toHaveBeenCalledWith({ where: { id: 'f2' } });
  });

  it('запрос к БД фильтрует по messageId:null и возрасту — сам крон не решает, что orphan, а что нет', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { fileArtifact: { findMany, delete: jest.fn() } };
    const storage = { delete: jest.fn() };
    const cron = new FilesCleanupCron(prisma as any, registryFor(storage) as any);

    await cron.cleanupOrphanUploads();

    expect(findMany).toHaveBeenCalledWith({
      where: { messageId: null, createdAt: { lt: expect.any(Date) } },
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  // P1 (внешний аудит 20.09.2026) — раньше storage.delete() глотал любую
  // ошибку файловой системы, и эта строка удаляла FileArtifact из БД
  // безусловно сразу после — физический файл мог остаться на диске, но
  // единственная запись, по которой его можно было бы найти и повторить
  // попытку, уже удалена. LocalFileStorageService.delete теперь
  // пробрасывает настоящие ошибки — крон должен на них реагировать,
  // не удаляя строку и не роняя весь прогон целиком.
  it('storage.delete() бросает настоящую ошибку диска — DB-строка НЕ удаляется, остальные orphan\'ы в той же партии всё равно обрабатываются', async () => {
    const orphan1 = { id: 'f1', storageKey: 'key-1', messageId: null, createdAt: new Date('2020-01-01') };
    const orphan2 = { id: 'f2', storageKey: 'key-2', messageId: null, createdAt: new Date('2020-01-01') };
    const prisma = {
      fileArtifact: {
        findMany: jest.fn().mockResolvedValue([orphan1, orphan2]),
        delete: jest.fn(),
      },
    };
    const storage = {
      delete: jest.fn().mockRejectedValueOnce(new Error('EACCES: permission denied')).mockResolvedValueOnce(undefined),
    };
    const cron = new FilesCleanupCron(prisma as any, registryFor(storage) as any);

    await cron.cleanupOrphanUploads();

    expect(storage.delete).toHaveBeenCalledWith('key-1');
    expect(storage.delete).toHaveBeenCalledWith('key-2');
    // f1 — storage.delete упал, строка в БД остаётся для повтора следующим прогоном.
    expect(prisma.fileArtifact.delete).not.toHaveBeenCalledWith({ where: { id: 'f1' } });
    // f2 — успешно, обработан несмотря на то, что f1 перед ним упал.
    expect(prisma.fileArtifact.delete).toHaveBeenCalledWith({ where: { id: 'f2' } });
  });
});

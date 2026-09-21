import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LocalFileStorageService } from './file-storage.service';

// P1 (внешний аудит 20.09.2026) — раньше delete() глотал ЛЮБУЮ ошибку
// файловой системы, не только "файла и так уже нет" (ENOENT). Реальная
// файловая система, не мок fs — семантика errno-кодов (ENOENT vs EACCES)
// это ровно то поведение платформы, которое проверяется, мокать fs
// означало бы проверять собственные же заглушки, а не настоящее поведение.
function configWith(dir: string) {
  return { get: jest.fn().mockReturnValue(dir) } as any;
}

describe('LocalFileStorageService.delete (P1, аудит 20.09.2026)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-storage-test-'));
  });

  afterEach(async () => {
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('файл существует — успешно удаляет', async () => {
    const storage = new LocalFileStorageService(configWith(dir));
    const key = await storage.save(Buffer.from('hello'));

    await expect(storage.delete(key)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, key))).toBe(false);
  });

  it('файла уже нет (ENOENT) — считается успехом, не бросает', async () => {
    const storage = new LocalFileStorageService(configWith(dir));

    await expect(storage.delete('never-existed')).resolves.toBeUndefined();
  });

  it('настоящая ошибка файловой системы (не ENOENT) — пробрасывается, не глотается', async () => {
    const storage = new LocalFileStorageService(configWith(dir));
    const key = await storage.save(Buffer.from('hello'));
    // Убираем права на запись у родительской директории — unlink требует
    // права на запись в директории, не на сам файл, поэтому это надёжно
    // воспроизводит EACCES/EPERM независимо от прав самого файла.
    await fsPromises.chmod(dir, 0o500);

    try {
      await expect(storage.delete(key)).rejects.toThrow();
    } finally {
      // Восстанавливаем права, иначе afterEach не сможет rm -rf директорию.
      await fsPromises.chmod(dir, 0o700);
    }
  });
});

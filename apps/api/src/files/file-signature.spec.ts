import { isSuspiciousUpload } from './file-signature';

// Stage 2, Phase F.1 (аудит 16.09.2026) — client.mimetype нельзя доверять
// как единственному подтверждению формата, magic bytes — второй, независимый
// от клиента источник истины.
describe('isSuspiciousUpload', () => {
  it('настоящий PDF с declared application/pdf — не подозрительный', () => {
    const buffer = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'application/pdf')).toBe(false);
  });

  it('настоящий PNG с declared image/png — не подозрительный', () => {
    const buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'image/png')).toBe(false);
  });

  it('PDF-подпись, но declared image/png — подозрительный (spoofed MIME)', () => {
    const buffer = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'image/png')).toBe(true);
  });

  it('исполняемый Windows PE ("MZ"), заявленный как text/plain — подозрительный', () => {
    const buffer = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'text/plain')).toBe(true);
  });

  it('исполняемый Linux ELF, заявленный как image/png — подозрительный', () => {
    const buffer = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'image/png')).toBe(true);
  });

  it('обычный текст с declared text/plain — не подозрительный (нет позитивной сигнатуры, но и не похож на бинарник)', () => {
    const buffer = Buffer.from('Привет, это обычный текстовый файл', 'utf8');
    expect(isSuspiciousUpload(buffer, 'text/plain')).toBe(false);
  });

  it('ZIP-контейнер с declared xlsx — не подозрительный (docx/xlsx проверяются только как "это ZIP")', () => {
    const buffer = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20)]);
    expect(isSuspiciousUpload(buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(false);
  });

  it('не-ZIP с declared xlsx — подозрительный', () => {
    const buffer = Buffer.alloc(20);
    expect(isSuspiciousUpload(buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
  });
});

import { StorageRegistry } from './storage-registry.service';

// Stage 2, Phase H.2 (внешний аудит 20.09.2026, P2) — заготовка на будущее
// (local -> MinIO/S3): единственный сегодняшний провайдер регистрируется
// через onModuleInit (см. сам сервис), здесь тестируется сама механика
// register/resolve независимо от того, сколько провайдеров реально
// зарегистрировано.
describe('StorageRegistry', () => {
  it('resolve возвращает зарегистрированный provider по его provider-строке', () => {
    const local = { provider: 'local', save: jest.fn(), getStream: jest.fn(), delete: jest.fn() };
    const registry = new StorageRegistry(local as any);
    registry.register(local);

    expect(registry.resolve('local')).toBe(local);
  });

  it('resolve неизвестного provider бросает понятную ошибку, а не возвращает undefined молча', () => {
    const local = { provider: 'local', save: jest.fn(), getStream: jest.fn(), delete: jest.fn() };
    const registry = new StorageRegistry(local as any);
    registry.register(local);

    expect(() => registry.resolve('minio')).toThrow('minio');
  });

  it('onModuleInit регистрирует local storage, переданный в конструктор', () => {
    const local = { provider: 'local', save: jest.fn(), getStream: jest.fn(), delete: jest.fn() };
    const registry = new StorageRegistry(local as any);

    registry.onModuleInit();

    expect(registry.resolve('local')).toBe(local);
  });
});

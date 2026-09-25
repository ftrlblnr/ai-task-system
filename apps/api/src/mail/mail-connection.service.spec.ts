import { BadRequestException } from '@nestjs/common';
import { MailConnectionService } from './mail-connection.service';
import { MailConnectError } from './providers/email-provider';

function setup(openSession: jest.Mock = jest.fn().mockResolvedValue({ close: jest.fn().mockResolvedValue(undefined) })) {
  const store = {
    upsertMailbox: jest.fn().mockResolvedValue({ id: 'mb1' }),
    getMailboxStatusByEmployee: jest.fn(),
    countMessages: jest.fn().mockResolvedValue(42),
    deleteMailboxByEmployee: jest.fn().mockResolvedValue(undefined),
  };
  const secretBox = { encrypt: jest.fn().mockImplementation((v: string) => `ENC(${v})`) };
  const registry = { get: jest.fn().mockReturnValue({ openSession }) };
  const sync = { syncMailbox: jest.fn().mockResolvedValue({ status: 'ok' }) };
  const service = new MailConnectionService(store as any, secretBox as any, registry as any, sync as any);
  return { service, store, secretBox, openSession, sync };
}

describe('MailConnectionService.connect', () => {
  it('успех: вход проверен ДО сохранения, пароль сохранён только зашифрованным, адрес нормализован, синк запущен в фоне', async () => {
    const { service, store, secretBox, openSession, sync } = setup();

    const result = await service.connect('e1', { emailAddress: '  Boss@Mail.RU ', appPassword: 'app-pass', initialDays: 90 });

    expect(result).toEqual({ ok: true });
    expect(openSession).toHaveBeenCalledWith({ emailAddress: 'boss@mail.ru', appPassword: 'app-pass' });
    expect(secretBox.encrypt).toHaveBeenCalledWith('app-pass');
    const saved = store.upsertMailbox.mock.calls[0][0];
    expect(saved).toEqual({ employeeId: 'e1', emailAddress: 'boss@mail.ru', appPasswordEncrypted: 'ENC(app-pass)', initialDays: 90 });
    expect(JSON.stringify(saved)).not.toMatch(/"app-pass"/); // открытого пароля в записи нет
    expect(sync.syncMailbox).toHaveBeenCalledWith('mb1');
  });

  it('неверный пароль приложения — понятная ошибка про пароль ПРИЛОЖЕНИЯ, ящик не сохраняется', async () => {
    const { service, store, sync } = setup(jest.fn().mockRejectedValue(new MailConnectError('INVALID_CREDENTIALS')));

    const error = await service.connect('e1', { emailAddress: 'boss@mail.ru', appPassword: 'wrong' }).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('пароль для внешнего приложения');
    expect(error.message).not.toContain('wrong');
    expect(store.upsertMailbox).not.toHaveBeenCalled();
    expect(sync.syncMailbox).not.toHaveBeenCalled();
  });

  it('IMAP выключен — ошибка с инструкцией включить доступ', async () => {
    const { service } = setup(jest.fn().mockRejectedValue(new MailConnectError('IMAP_DISABLED')));

    await expect(service.connect('e1', { emailAddress: 'boss@mail.ru', appPassword: 'p' })).rejects.toThrow(/IMAP выключен/);
  });

  it('таймаут и неизвестная ошибка — безопасные сообщения без деталей исключения', async () => {
    const timeout = setup(jest.fn().mockRejectedValue(new MailConnectError('TIMEOUT')));
    await expect(timeout.service.connect('e1', { emailAddress: 'boss@mail.ru', appPassword: 'p' })).rejects.toThrow(/не отвечает/);

    const unknown = setup(jest.fn().mockRejectedValue(new Error('LOGIN boss@mail.ru p failed: internal detail')));
    const error = await unknown.service.connect('e1', { emailAddress: 'boss@mail.ru', appPassword: 'p' }).catch((e) => e);
    expect(error.message).toBe('Не удалось подключиться к Mail.ru. Проверьте адрес и повторите попытку.');
    expect(error.message).not.toContain('internal detail');
  });

  it('недопустимое окно первой синхронизации — отказ до обращения к Mail.ru', async () => {
    const { service, openSession } = setup();

    await expect(service.connect('e1', { emailAddress: 'boss@mail.ru', appPassword: 'p', initialDays: 7 })).rejects.toThrow(BadRequestException);
    expect(openSession).not.toHaveBeenCalled();
  });

  it('по умолчанию окно — 30 дней', async () => {
    const { service, store } = setup();

    await service.connect('e1', { emailAddress: 'boss@mail.ru', appPassword: 'p' });

    expect(store.upsertMailbox.mock.calls[0][0].initialDays).toBe(30);
  });
});

describe('MailConnectionService.status/disconnect', () => {
  it('не подключено → connected:false', async () => {
    const { service, store } = setup();
    store.getMailboxStatusByEmployee.mockResolvedValue(null);

    expect(await service.status('e1')).toEqual({ connected: false });
  });

  it('подключено → статус со счётчиком писем, БЕЗ пароля', async () => {
    const { service, store } = setup();
    store.getMailboxStatusByEmployee.mockResolvedValue({ id: 'mb1', emailAddress: 'boss@mail.ru', syncEnabled: true, syncState: 'IDLE', lastError: null, lastSyncedAt: null, initialDays: 30 });

    const status = await service.status('e1');

    expect(status).toMatchObject({ connected: true, emailAddress: 'boss@mail.ru', messageCount: 42 });
    expect(JSON.stringify(status)).not.toMatch(/password|Encrypted/i);
  });

  it('disconnect удаляет ящик сотрудника', async () => {
    const { service, store } = setup();

    await service.disconnect('e1');

    expect(store.deleteMailboxByEmployee).toHaveBeenCalledWith('e1');
  });
});

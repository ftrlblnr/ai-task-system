import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MailConnectionService, MAX_MAILBOXES_PER_EMPLOYEE } from './mail-connection.service';
import { MailConnectError } from './providers/email-provider';

const CORP_SERVERS = { imapHost: 'mail.corp.kz', imapPort: 993, imapSecure: true, smtpHost: 'mail.corp.kz', smtpPort: 587, smtpSecure: false };

function setup(openSession: jest.Mock = jest.fn().mockResolvedValue({ close: jest.fn().mockResolvedValue(undefined) })) {
  const store = {
    upsertMailbox: jest.fn().mockResolvedValue({ id: 'mb1' }),
    listMailboxesByEmployee: jest.fn().mockResolvedValue([]),
    countMessages: jest.fn().mockResolvedValue(42),
    deleteMailbox: jest.fn().mockResolvedValue(true),
  };
  const secretBox = { encrypt: jest.fn().mockImplementation((v: string) => `ENC(${v})`) };
  const registry = { get: jest.fn().mockReturnValue({ openSession }) };
  const sync = { syncMailbox: jest.fn().mockResolvedValue({ status: 'ok' }) };
  const smtp = { verify: jest.fn().mockResolvedValue(undefined) };
  const service = new MailConnectionService(store as any, secretBox as any, registry as any, sync as any, smtp as any);
  return { service, store, secretBox, openSession, sync, smtp, registry };
}

describe('MailConnectionService.connect', () => {
  it('Mail.ru: вход по IMAP и SMTP проверен ДО сохранения, пароль только зашифрованным, синк в фоне', async () => {
    const { service, store, secretBox, openSession, sync, smtp } = setup();

    const result = await service.connect('e1', { emailAddress: '  Boss@Mail.RU ', appPassword: 'app-pass', initialDays: 90 });

    expect(result).toEqual({ ok: true, mailboxId: 'mb1' });
    expect(openSession).toHaveBeenCalledWith({
      emailAddress: 'boss@mail.ru',
      appPassword: 'app-pass',
      login: 'boss@mail.ru',
      imap: { host: 'imap.mail.ru', port: 993, secure: true },
    });
    expect(smtp.verify).toHaveBeenCalledWith(expect.objectContaining({ smtpHost: 'smtp.mail.ru', smtpPort: 465 }), { login: 'boss@mail.ru', password: 'app-pass' });
    expect(secretBox.encrypt).toHaveBeenCalledWith('app-pass');
    const saved = store.upsertMailbox.mock.calls[0][0];
    expect(saved).toMatchObject({ employeeId: 'e1', provider: 'MAIL_RU', emailAddress: 'boss@mail.ru', imapHost: 'imap.mail.ru', appPasswordEncrypted: 'ENC(app-pass)', initialDays: 90 });
    expect(JSON.stringify(saved)).not.toMatch(/"app-pass"/);
    expect(sync.syncMailbox).toHaveBeenCalledWith('mb1');
  });

  it('свой сервер: серверы и логин пользователя уходят в IMAP и SMTP', async () => {
    const { service, store, openSession, smtp } = setup();

    await service.connect('e1', { provider: 'IMAP', emailAddress: 'boss@corp.kz', appPassword: 'p', login: 'CORP\\boss', displayName: 'Жанна', servers: CORP_SERVERS });

    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ login: 'CORP\\boss', imap: { host: 'mail.corp.kz', port: 993, secure: true } }));
    expect(smtp.verify).toHaveBeenCalledWith(CORP_SERVERS, { login: 'CORP\\boss', password: 'p' });
    expect(store.upsertMailbox.mock.calls[0][0]).toMatchObject({ provider: 'IMAP', login: 'CORP\\boss', displayName: 'Жанна', smtpPort: 587, smtpSecure: false });
  });

  it('свой сервер без серверов — отказ без подключения', async () => {
    const { service, openSession } = setup();

    await expect(service.connect('e1', { provider: 'IMAP', emailAddress: 'boss@corp.kz', appPassword: 'p' })).rejects.toThrow(/серверы/);
    expect(openSession).not.toHaveBeenCalled();
  });

  it('неверный пароль приложения Mail.ru — понятная ошибка, ящик не сохраняется', async () => {
    const { service, store, sync } = setup(jest.fn().mockRejectedValue(new MailConnectError('INVALID_CREDENTIALS')));

    const error = await service.connect('e1', { emailAddress: 'boss@mail.ru', appPassword: 'wrong' }).catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toContain('пароль для внешнего приложения');
    expect(error.message).not.toContain('wrong');
    expect(store.upsertMailbox).not.toHaveBeenCalled();
    expect(sync.syncMailbox).not.toHaveBeenCalled();
  });

  it('IMAP прошёл, SMTP отказал — ошибка с пометкой «Отправка», ящик не сохраняется', async () => {
    const { service, store, smtp } = setup();
    smtp.verify.mockRejectedValue(new MailConnectError('TIMEOUT'));

    await expect(service.connect('e1', { provider: 'IMAP', emailAddress: 'boss@corp.kz', appPassword: 'p', servers: CORP_SERVERS })).rejects.toThrow(/^Отправка \(SMTP\): Сервер не отвечает/);
    expect(store.upsertMailbox).not.toHaveBeenCalled();
  });

  it('сертификат сервера не прошёл проверку — отдельный понятный текст', async () => {
    const { service } = setup(jest.fn().mockRejectedValue(new MailConnectError('TLS_ERROR')));

    await expect(service.connect('e1', { provider: 'IMAP', emailAddress: 'boss@corp.kz', appPassword: 'p', servers: CORP_SERVERS })).rejects.toThrow(/Сертификат/);
  });

  it('неизвестная ошибка — безопасное сообщение без деталей исключения', async () => {
    const { service } = setup(jest.fn().mockRejectedValue(new Error('LOGIN boss@mail.ru p failed: internal detail')));

    const error = await service.connect('e1', { emailAddress: 'boss@mail.ru', appPassword: 'p' }).catch((e) => e);

    expect(error.message).toBe('IMAP: Не удалось подключиться к Mail.ru. Проверьте адрес и повторите попытку.');
  });

  it('лимит ящиков: новый адрес сверх лимита — отказ; переподключение существующего — можно', async () => {
    const { service, store } = setup();
    store.listMailboxesByEmployee.mockResolvedValue(Array.from({ length: MAX_MAILBOXES_PER_EMPLOYEE }, (_, i) => ({ id: `m${i}`, emailAddress: `a${i}@mail.ru` })));

    await expect(service.connect('e1', { emailAddress: 'new@mail.ru', appPassword: 'p' })).rejects.toThrow(/не больше/);
    await expect(service.connect('e1', { emailAddress: 'a0@mail.ru', appPassword: 'p' })).resolves.toMatchObject({ ok: true });
  });

  it('недопустимое окно первой синхронизации — отказ до подключения', async () => {
    const { service, openSession } = setup();

    await expect(service.connect('e1', { emailAddress: 'boss@mail.ru', appPassword: 'p', initialDays: 7 })).rejects.toThrow(BadRequestException);
    expect(openSession).not.toHaveBeenCalled();
  });
});

describe('MailConnectionService.status/disconnect', () => {
  it('список ящиков со счётчиком писем, без пароля', async () => {
    const { service, store } = setup();
    store.listMailboxesByEmployee.mockResolvedValue([{ id: 'mb1', emailAddress: 'boss@mail.ru', syncState: 'IDLE' }]);

    const status = await service.status('e1');

    expect(status).toEqual({ mailboxes: [{ id: 'mb1', emailAddress: 'boss@mail.ru', syncState: 'IDLE', messageCount: 42 }] });
    expect(JSON.stringify(status)).not.toMatch(/password|Encrypted/i);
  });

  it('disconnect удаляет только свой ящик; чужой — 404', async () => {
    const { service, store } = setup();

    await service.disconnect('e1', 'mb1');
    expect(store.deleteMailbox).toHaveBeenCalledWith('e1', 'mb1');

    store.deleteMailbox.mockResolvedValue(false);
    await expect(service.disconnect('e1', 'other')).rejects.toBeInstanceOf(NotFoundException);
  });
});

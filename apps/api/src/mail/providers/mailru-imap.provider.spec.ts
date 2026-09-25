import { MailConnectError } from './email-provider';

// imapflow целиком замокан — реальный Mail.ru в тестах не участвует.
const connectMock = jest.fn();
const logoutMock = jest.fn().mockResolvedValue(undefined);
jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({ connect: connectMock, logout: logoutMock })),
}));

import { ImapFlow } from 'imapflow';
import { MailRuImapProvider, normalizeParsedMail, MAX_TEXT_CHARS } from './mailru-imap.provider';

const creds = { emailAddress: 'boss@mail.ru', appPassword: 'app-secret-pass' };

describe('MailRuImapProvider.openSession — подключение', () => {
  beforeEach(() => {
    connectMock.mockReset();
    (ImapFlow as unknown as jest.Mock).mockClear();
  });

  it('успешное подключение: imap.mail.ru:993 TLS, логгер выключен (пароль не попадает в лог)', async () => {
    connectMock.mockResolvedValue(undefined);

    const session = await new MailRuImapProvider().openSession(creds);

    expect(session).toBeDefined();
    const options = (ImapFlow as unknown as jest.Mock).mock.calls[0][0];
    expect(options).toMatchObject({ host: 'imap.mail.ru', port: 993, secure: true, logger: false });
    expect(options.auth).toEqual({ user: 'boss@mail.ru', pass: 'app-secret-pass' });
  });

  it('неверный пароль приложения → INVALID_CREDENTIALS', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'Invalid credentials' }));

    await expect(new MailRuImapProvider().openSession(creds)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('IMAP выключен в настройках ящика → IMAP_DISABLED', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'IMAP access is disabled' }));

    await expect(new MailRuImapProvider().openSession(creds)).rejects.toMatchObject({ code: 'IMAP_DISABLED' });
  });

  it('сеть/таймаут → TIMEOUT; прочее → UNKNOWN', async () => {
    connectMock.mockRejectedValueOnce(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    await expect(new MailRuImapProvider().openSession(creds)).rejects.toMatchObject({ code: 'TIMEOUT' });

    connectMock.mockRejectedValueOnce(new Error('что-то странное'));
    await expect(new MailRuImapProvider().openSession(creds)).rejects.toMatchObject({ code: 'UNKNOWN' });
  });

  it('ошибка подключения несёт только безопасный код — без пароля и текста исключения', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('LOGIN boss@mail.ru app-secret-pass failed'), { authenticationFailed: true }));

    const error = await new MailRuImapProvider().openSession(creds).catch((e) => e);

    expect(error).toBeInstanceOf(MailConnectError);
    expect(JSON.stringify(error)).not.toContain('app-secret-pass');
    expect(error.message).toBe('INVALID_CREDENTIALS');
  });

  it('переподключение: после сбоя следующая попытка открывает новую сессию', async () => {
    connectMock.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ECONNRESET' })).mockResolvedValueOnce(undefined);
    const provider = new MailRuImapProvider();

    await expect(provider.openSession(creds)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(provider.openSession(creds)).resolves.toBeDefined();
  });
});

describe('normalizeParsedMail — нормализация разобранного письма', () => {
  const base = (over: Record<string, unknown> = {}) =>
    ({
      messageId: '<m1@x>',
      subject: 'Тема',
      from: { value: [{ address: 'Partner@IDAT.kz', name: 'Партнёр' }] },
      to: { value: [{ address: 'boss@mail.ru', name: '' }] },
      date: new Date('2026-09-23T10:00:00Z'),
      text: 'Привет',
      headers: new Map<string, unknown>(),
      attachments: [],
      ...over,
    }) as any;
  const meta = { uid: 7, isRead: false, receivedAt: new Date('2026-09-23T10:00:05Z'), truncated: false };

  it('адреса в нижнем регистре, references/inReplyTo, тело и флаги', () => {
    const m = normalizeParsedMail(base({ inReplyTo: '<p@x>', references: ['<a@x>', '<p@x>'] }), meta);

    expect(m.from).toEqual({ address: 'partner@idat.kz', name: 'Партнёр' });
    expect(m.to[0].address).toBe('boss@mail.ru');
    expect(m.inReplyTo).toBe('<p@x>');
    expect(m.references).toEqual(['<a@x>', '<p@x>']);
    expect(m.textBody).toBe('Привет');
    expect(m.isRead).toBe(false);
    expect(m.isAutomated).toBe(false);
  });

  it('вложения — только метаданные; inline без имени не считаются', () => {
    const m = normalizeParsedMail(
      base({
        attachments: [
          { filename: 'Contract_v3.docx', contentType: 'application/x', contentDisposition: 'attachment', size: 1234 },
          { filename: undefined, contentType: 'image/png', contentDisposition: 'inline', size: 10 },
        ],
      }),
      meta,
    );

    expect(m.hasAttachments).toBe(true);
    expect(m.attachments).toEqual([{ fileName: 'Contract_v3.docx', mimeType: 'application/x', sizeBytes: 1234, partId: null }]);
  });

  it('рассылка/автоматика распознаётся по заголовкам и адресу (без LLM)', () => {
    expect(normalizeParsedMail(base({ headers: new Map([['list-unsubscribe', '<mailto:x>']]) }), meta).isAutomated).toBe(true);
    expect(normalizeParsedMail(base({ headers: new Map([['precedence', 'bulk']]) }), meta).isAutomated).toBe(true);
    expect(normalizeParsedMail(base({ from: { value: [{ address: 'noreply@shop.com' }] } }), meta).isAutomated).toBe(true);
  });

  it('тело режется по потолку и помечается обрезанным; нет text — текст из html', () => {
    const long = normalizeParsedMail(base({ text: 'а'.repeat(MAX_TEXT_CHARS + 10) }), meta);
    expect(long.textBody?.length).toBe(MAX_TEXT_CHARS);
    expect(long.bodyTruncated).toBe(true);

    const fromHtml = normalizeParsedMail(base({ text: undefined, html: '<p>Здравствуйте</p><p>Жду ответа</p>' }), meta);
    expect(fromHtml.textBody).toContain('Здравствуйте');
    expect(fromHtml.textBody).toContain('Жду ответа');
  });
});

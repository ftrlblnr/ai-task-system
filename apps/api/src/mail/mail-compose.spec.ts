import { simpleParser } from 'mailparser';
import { buildQuote, composeMessage, forwardSubject, formatQuoteDate, htmlFragment, replyRecipients, replySubject, threadHeaders, type SourceMessage } from './mail-compose';
import { normalizeAddressList } from './mail-compose.service';

const source = (over: Partial<SourceMessage> = {}): SourceMessage => ({
  internetMessageId: '<m2@partner.kz>',
  referencesIds: ['<m1@corp.kz>'],
  subject: 'Поставка бетона',
  fromAddress: 'partner@partner.kz',
  fromName: 'Партнёр',
  isOutgoing: false,
  sentAt: new Date('2026-10-23T05:15:00Z'),
  receivedAt: null,
  textBody: 'Добрый день!\nСрок — пятница.',
  htmlBody: null,
  recipients: [
    { type: 'TO', address: 'boss@corp.kz', name: 'Жанна' },
    { type: 'TO', address: 'deputy@corp.kz', name: null },
    { type: 'CC', address: 'lawyer@corp.kz', name: null },
    { type: 'CC', address: 'PARTNER@partner.kz', name: null },
  ],
  ...over,
});

describe('mail-compose: тема и получатели', () => {
  it('Re:/Fwd: не дублируются', () => {
    expect(replySubject('Поставка')).toBe('Re: Поставка');
    expect(replySubject('RE: Поставка')).toBe('RE: Поставка');
    expect(replySubject('Ответ: Поставка')).toBe('Ответ: Поставка');
    expect(replySubject(null)).toBe('Re:');
    expect(forwardSubject('Fw: Акт')).toBe('Fw: Акт');
    expect(forwardSubject('Акт')).toBe('Fwd: Акт');
  });

  it('ответ — отправителю; ответ всем — плюс остальные без себя и без повторов', () => {
    expect(replyRecipients(source(), 'REPLY', 'Boss@corp.kz')).toEqual({ to: ['partner@partner.kz'], cc: [] });
    expect(replyRecipients(source(), 'REPLY_ALL', 'boss@corp.kz')).toEqual({ to: ['partner@partner.kz'], cc: ['deputy@corp.kz', 'lawyer@corp.kz'] });
  });

  it('ответ на своё письмо из «Отправленных» — тем же получателям', () => {
    const own = source({ isOutgoing: true, fromAddress: 'boss@corp.kz' });
    expect(replyRecipients(own, 'REPLY', 'boss@corp.kz').to).toEqual(['boss@corp.kz', 'deputy@corp.kz']);
    expect(replyRecipients(own, 'REPLY_ALL', 'boss@corp.kz').cc).toEqual(['lawyer@corp.kz', 'partner@partner.kz']);
  });

  it('In-Reply-To и References продолжают цепочку', () => {
    expect(threadHeaders(source())).toEqual({ inReplyTo: '<m2@partner.kz>', references: ['<m1@corp.kz>', '<m2@partner.kz>'] });
    expect(threadHeaders(source({ internetMessageId: null }))).toEqual({});
  });

  it('адреса: «Имя <адрес>» → адрес, нижний регистр, без повторов; мусор — понятная ошибка', () => {
    expect(normalizeAddressList(['Жанна <Boss@Corp.kz>', 'boss@corp.kz', ' x@y.kz '], 'Кому')).toEqual(['boss@corp.kz', 'x@y.kz']);
    expect(() => normalizeAddressList(['не адрес'], 'Кому')).toThrow(/Кому/);
  });
});

describe('mail-compose: цитата', () => {
  it('шапка как в Outlook, время Казахстана', () => {
    const q = buildQuote(source(), 'REPLY');
    expect(formatQuoteDate(new Date('2026-10-23T05:15:00Z'))).toBe('23 октября 2026 г. 10:15');
    expect(q.text).toContain('От: Партнёр <partner@partner.kz>');
    expect(q.text).toContain('Копия: lawyer@corp.kz; PARTNER@partner.kz');
    expect(q.text).toContain('Срок — пятница.');
  });

  it('HTML исходного письма вкладывается без скриптов и <head>; текст экранируется', () => {
    expect(htmlFragment('<html><head><title>x</title></head><body><p>Hi</p><script>alert(1)</script></body></html>')).toBe('<p>Hi</p>');
    const q = buildQuote(source({ fromName: '<b>X</b>' }), 'FORWARD');
    expect(q.html).toContain('&lt;b&gt;X&lt;/b&gt;');
    expect(q.text).toMatch(/^-------- Пересылаемое сообщение/);
  });
});

describe('mail-compose: MIME', () => {
  it('скрытая копия — только в конверте и в копии для «Отправленных»; вложения и заголовки цепочки на месте', async () => {
    const msg = await composeMessage({
      from: { address: 'boss@corp.kz', name: 'Жанна' },
      to: ['partner@partner.kz'],
      cc: ['lawyer@corp.kz'],
      bcc: ['secret@corp.kz'],
      subject: 'Re: Поставка',
      body: 'Согласовано <ок>',
      quote: buildQuote(source(), 'REPLY'),
      ...threadHeaders(source()),
      attachments: [{ filename: 'акт.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }],
    });

    expect(msg.messageId).toMatch(/^<[0-9a-f-]+@corp\.kz>$/);
    expect(msg.envelope).toEqual({ from: 'boss@corp.kz', to: ['partner@partner.kz', 'lawyer@corp.kz', 'secret@corp.kz'] });
    expect(msg.raw.toString()).not.toMatch(/^Bcc:/m);
    expect(msg.rawWithBcc.toString()).toMatch(/^Bcc: secret@corp\.kz/m);

    const parsed = await simpleParser(msg.raw);
    expect(parsed.messageId).toBe(msg.messageId);
    expect(parsed.from?.value[0]).toEqual({ address: 'boss@corp.kz', name: 'Жанна' });
    expect(parsed.inReplyTo).toBe('<m2@partner.kz>');
    expect(parsed.subject).toBe('Re: Поставка');
    expect(parsed.text).toContain('Согласовано <ок>');
    expect(parsed.text).toContain('-------- Исходное сообщение --------');
    expect(parsed.html).toContain('Согласовано &lt;ок&gt;');
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['акт.pdf']);
  });
});

import { NotFoundException } from '@nestjs/common';
import { buildEmailWhere, MailQueryService, parseEmailFilters, MAX_LIST_LIMIT } from './mail-query.service';

describe('buildEmailWhere — фильтры локальной почты', () => {
  it('по умолчанию: только входящие своего ящика, без пропавших с сервера', () => {
    expect(buildEmailWhere('mb1', {})).toEqual({ mailboxId: 'mb1', providerMissing: false, isOutgoing: false });
  });

  it('диапазон дат по receivedAt: [from, to)', () => {
    const from = new Date('2026-09-23T00:00:00+05:00');
    const to = new Date('2026-09-24T00:00:00+05:00');

    expect(buildEmailWhere('mb1', { dateFrom: from, dateTo: to }).receivedAt).toEqual({ gte: from, lt: to });
  });

  it('непрочитанные / прочитанные / все', () => {
    expect(buildEmailWhere('mb1', { readStatus: 'unread' }).isRead).toBe(false);
    expect(buildEmailWhere('mb1', { readStatus: 'read' }).isRead).toBe(true);
    expect(buildEmailWhere('mb1', { readStatus: 'all' })).not.toHaveProperty('isRead');
  });

  it('направление: outgoing / all', () => {
    expect(buildEmailWhere('mb1', { direction: 'outgoing' }).isOutgoing).toBe(true);
    expect(buildEmailWhere('mb1', { direction: 'all' })).not.toHaveProperty('isOutgoing');
  });

  it('отправитель ищется по адресу И имени, без учёта регистра (например «IDAT»)', () => {
    const where = buildEmailWhere('mb1', { sender: 'IDAT' });

    expect(where.AND).toEqual([{ OR: [{ fromAddress: { contains: 'IDAT', mode: 'insensitive' } }, { fromName: { contains: 'IDAT', mode: 'insensitive' } }] }]);
  });

  it('текстовый поиск: тема, тело, отправитель и AI-summary', () => {
    const where = buildEmailWhere('mb1', { query: 'Alatau City' });
    const or = (where.AND as any[])[0].OR;

    expect(or).toHaveLength(5);
    expect(JSON.stringify(or)).toContain('textBody');
    expect(JSON.stringify(or)).toContain('summary');
  });

  it('статус ответа — по треду; важность/нужен ответ/нужно действие — по анализу', () => {
    const where = buildEmailWhere('mb1', { replyStatus: 'AWAITING_MY_REPLY', importance: ['CRITICAL', 'IMPORTANT'], needsAction: true });

    expect(where.thread).toEqual({ is: { replyStatus: 'AWAITING_MY_REPLY' } });
    expect(where.analysis).toEqual({ is: { importance: { in: ['CRITICAL', 'IMPORTANT'] }, needsAction: true } });
  });

  it('получатель и наличие вложений', () => {
    const where = buildEmailWhere('mb1', { recipient: 'boss', hasAttachments: true });

    expect(where.hasAttachments).toBe(true);
    expect(JSON.stringify(where.AND)).toContain('recipients');
  });
});

describe('parseEmailFilters — параметры из URL', () => {
  it('разбирает даты, булевы, списки; мусор отбрасывается', () => {
    const f = parseEmailFilters({
      dateFrom: '2026-09-20',
      dateTo: 'не дата',
      readStatus: 'unread',
      replyStatus: 'AWAITING_MY_REPLY',
      importance: 'CRITICAL,LOL,IMPORTANT',
      hasAttachments: 'true',
      q: 'договор',
    });

    expect(f.dateFrom).toBeInstanceOf(Date);
    expect(f.dateTo).toBeUndefined();
    expect(f.readStatus).toBe('unread');
    expect(f.replyStatus).toBe('AWAITING_MY_REPLY');
    expect(f.importance).toEqual(['CRITICAL', 'IMPORTANT']);
    expect(f.hasAttachments).toBe(true);
    expect(f.query).toBe('договор');
  });

  it('недопустимые значения enum игнорируются', () => {
    expect(parseEmailFilters({ replyStatus: 'HACK', readStatus: 'weird' })).toMatchObject({ replyStatus: undefined, readStatus: undefined });
  });
});

describe('MailQueryService', () => {
  it('search: лимит ограничен MAX_LIST_LIMIT, NaN → значение по умолчанию, всегда фильтр по ящику', async () => {
    const prisma = { emailMessage: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } };
    const service = new MailQueryService(prisma as any);

    await service.search('mb1', {}, { limit: 9999, offset: NaN });
    await service.search('mb1', {}, { limit: NaN });

    expect(prisma.emailMessage.findMany.mock.calls[0][0]).toMatchObject({ take: MAX_LIST_LIMIT, skip: 0, where: { mailboxId: 'mb1' } });
    expect(prisma.emailMessage.findMany.mock.calls[1][0].take).toBe(20);
  });

  it('getMessage: письмо другого ящика / несуществующее → 404 (запрос ограничен mailboxId)', async () => {
    const prisma = { emailMessage: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn() } };
    const service = new MailQueryService(prisma as any);

    await expect(service.getMessage('mb1', 'foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.emailMessage.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'foreign', mailboxId: 'mb1' });
  });

  it('getMessage: возвращает письмо с тредом', async () => {
    const prisma = {
      emailMessage: {
        findFirst: jest.fn().mockResolvedValue({ id: 'm1', threadId: 't1', subject: 'Тема' }),
        findMany: jest.fn().mockResolvedValue([{ id: 'm0' }, { id: 'm1' }]),
      },
    };
    const service = new MailQueryService(prisma as any);

    const result = await service.getMessage('mb1', 'm1');

    expect(result.threadMessages).toHaveLength(2);
    expect(prisma.emailMessage.findMany.mock.calls[0][0].where).toMatchObject({ threadId: 't1', mailboxId: 'mb1' });
  });
});

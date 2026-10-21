import { NpaSearchService } from './npa-search.service';

function makeService() {
  const prisma = {
    $queryRaw: jest.fn(),
    npaArticle: { findUnique: jest.fn() },
    npaGlossaryTerm: { findMany: jest.fn() },
  };
  return { prisma, service: new NpaSearchService(prisma as never) };
}

// $queryRaw — тегированный шаблон: (strings, ...значения параметров).
function params(call: unknown[]): unknown[] {
  return call.slice(1);
}

describe('NpaSearchService', () => {
  it('find: строгий поиск нашёл — запасной не вызывается', async () => {
    const { prisma, service } = makeService();
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'K990000409_:ст.474' }]);
    const hits = await service.find('неустойка поставка');
    expect(hits).toEqual([{ id: 'K990000409_:ст.474' }]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(params(prisma.$queryRaw.mock.calls[0] as unknown[])).toContain('неустойка поставка');
  });

  it('find: строгий пуст — повтор с «любым из слов»', async () => {
    const { prisma, service } = makeService();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'x' }]);
    const hits = await service.find('неустойка поставка');
    expect(hits).toEqual([{ id: 'x' }]);
    expect(params(prisma.$queryRaw.mock.calls[1] as unknown[])).toContain('неустойка or поставка');
  });

  it('find: лимит ограничен сверху', async () => {
    const { prisma, service } = makeService();
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'x' }]);
    await service.find('неустойка', { limit: 1000 });
    expect(params(prisma.$queryRaw.mock.calls[0] as unknown[])).toContain(30);
  });

  it('verifyQuote: нормализует id и различает «нет статьи» и «нет цитаты»', async () => {
    const { prisma, service } = makeService();
    prisma.npaArticle.findUnique.mockResolvedValueOnce({ text: 'не менее десяти лет' }).mockResolvedValueOnce(null);
    await expect(service.verifyQuote('К2600000253: ст. 122', 'НЕ МЕНЕЕ десяти лет')).resolves.toEqual({
      id: 'K2600000253:ст.122',
      exists: true,
      verified: true,
    });
    expect(prisma.npaArticle.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'K2600000253:ст.122' } }));
    await expect(service.verifyQuote('K1:ст.1', 'x')).resolves.toEqual({ id: 'K1:ст.1', exists: false, verified: false });
  });

  it('getArticle: даты отдаются строками YYYY-MM-DD, нет статьи — null', async () => {
    const { prisma, service } = makeService();
    prisma.npaArticle.findUnique
      .mockResolvedValueOnce({
        id: 'K1:ст.1',
        code: 'K1',
        article: '1',
        title: 'Т',
        path: [],
        text: 'текст',
        footnotes: [],
        excluded: false,
        pendingFrom: [new Date('2027-01-01T00:00:00Z')],
        expiresOn: [],
        document: { short: 'ГК', title: 'Кодекс', requisites: 'р', url: 'u' },
      })
      .mockResolvedValueOnce(null);
    const a = await service.getArticle('K1:ст.1');
    expect(a?.pendingFrom).toEqual(['2027-01-01']);
    expect(a?.short).toBe('ГК');
    await expect(service.getArticle('K1:ст.2')).resolves.toBeNull();
  });

  it('term: пустой запрос не ходит в БД', async () => {
    const { prisma, service } = makeService();
    await expect(service.term('  ')).resolves.toEqual([]);
    expect(prisma.npaGlossaryTerm.findMany).not.toHaveBeenCalled();
  });
});

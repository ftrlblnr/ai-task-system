import { parseRecord, toArticleRow, toDocumentRow, toTermRow } from './npa-import';

describe('npa-import: разбор строк выгрузки', () => {
  it('пустая строка пропускается, неизвестный kind — ошибка', () => {
    expect(parseRecord('   ')).toBeNull();
    expect(() => parseRecord('{"kind":"other"}')).toThrow('Неизвестный kind');
  });

  it('документ: даты в полночь UTC, отсутствующая редакция → null', () => {
    const doc = toDocumentRow({
      kind: 'document',
      code: 'K940001000_',
      short: 'ГК (Общая часть)',
      title: 'Гражданский кодекс',
      requisites: 'Кодекс от 27.12.1994',
      url: 'https://adilet.zan.kz/rus/docs/K940001000_',
      last_amendment: { date: '2026-06-19', act: '320-VIII' },
      source_date: '2026-10-19',
    });
    expect(doc.lastAmendmentDate?.toISOString()).toBe('2026-06-19T00:00:00.000Z');
    expect(doc.lastAmendmentAct).toBe('320-VIII');
    expect(doc.sourceDate?.toISOString()).toBe('2026-10-19T00:00:00.000Z');

    const bare = toDocumentRow({ kind: 'document', code: 'Z1', short: 's', title: 't', requisites: 'r', url: 'u', last_amendment: null });
    expect(bare.lastAmendmentDate).toBeNull();
    expect(bare.lastAmendmentAct).toBeNull();
    expect(bare.sourceDate).toBeNull();
  });

  it('статья: массивы и даты отложенного ввода', () => {
    const row = toArticleRow({
      kind: 'article',
      id: 'K030000442_:ст.43',
      code: 'K030000442_',
      article: '43',
      title: 'Порядок',
      path: ['Глава 1'],
      text: 'Текст',
      footnotes: [],
      excluded: false,
      amended_by: [['2012-01-06', '529-IV']],
      pending_from: ['2027-01-01'],
      expires_on: [],
      links: ['K1500000375'],
      watch: [],
    });
    expect(row.pendingFrom).toEqual([new Date('2027-01-01T00:00:00Z')]);
    expect(row.amendedBy).toEqual([['2012-01-06', '529-IV']]);
    expect(row.links).toEqual(['K1500000375']);
  });

  it('неверная дата — ошибка, а не тихий Invalid Date', () => {
    expect(() =>
      toDocumentRow({ kind: 'document', code: 'Z1', short: 's', title: 't', requisites: 'r', url: 'u', source_date: '19.10.2026' }),
    ).toThrow('Неверная дата');
  });

  it('термин глоссария', () => {
    expect(toTermRow({ kind: 'glossary', article_id: 'Z1:ст.1', code: 'Z1', term: 'дольщик', definition: 'лицо' })).toEqual({
      articleId: 'Z1:ст.1',
      code: 'Z1',
      term: 'дольщик',
      definition: 'лицо',
    });
  });
});

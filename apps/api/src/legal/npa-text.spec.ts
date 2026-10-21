import { normalizeArticleId, normQuote, queryWords, quoteInText } from './npa-text';

describe('npa-text', () => {
  it('normQuote: ёлочки/лапки, тире, ё, пробелы и регистр не влияют на сравнение', () => {
    expect(normQuote('  «Фасады» зданий —  НЕ менее ёмкости ')).toBe('"фасады" зданий - не менее емкости');
    expect(normQuote('“а” „б“ – в')).toBe('"а" "б" - в');
  });

  it('quoteInText: подтверждает дословную цитату с другой типографикой', () => {
    const text = 'Гарантийный срок на несущие конструкции, кровлю и наружные стены (фасады) зданий – не менее десяти лет.';
    expect(quoteInText('на несущие конструкции, кровлю и наружные стены (фасады) зданий — не менее ДЕСЯТИ лет', text)).toBe(true);
    expect(quoteInText('не менее восьми лет', text)).toBe(false);
  });

  it('quoteInText: пустая цитата не подтверждается', () => {
    expect(quoteInText('   ', 'любой текст')).toBe(false);
  });

  it('normalizeArticleId: приводит вариации модели к КОД:ст.N', () => {
    expect(normalizeArticleId('K2600000253:ст.122')).toBe('K2600000253:ст.122');
    expect(normalizeArticleId(' К2600000253 : ст. 122 ')).toBe('K2600000253:ст.122');
    expect(normalizeArticleId('K030000442_:статья 44-1')).toBe('K030000442_:ст.44-1');
    expect(normalizeArticleId('Z1600000486:ст.13')).toBe('Z1600000486:ст.13');
  });

  it('normalizeArticleId: непонятный id возвращается как есть (его отвергнет БД)', () => {
    expect(normalizeArticleId('  что-то ')).toBe('что-то');
  });

  it('queryWords: уникальные слова от 3 букв', () => {
    expect(queryWords('Неустойка, по поставке и неустойка 2026')).toEqual(['неустойка', 'поставке', '2026']);
  });
});

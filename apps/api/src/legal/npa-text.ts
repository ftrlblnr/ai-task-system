// Чистые функции базы НПА (агент-юрист): сравнение цитат и разбор id
// статьи. Без БД и ключей — тестируются напрямую.

// Нормализация для сравнения цитат — как `norm` в эталоне
// legal-agent/tools/search_npa.py (кавычки-ёлочки → ", тире → -, пробелы
// схлопнуты, регистр снят), плюс «лапки», ё/е и неразрывный пробел: модель
// и Word подставляют их сами, а смысл цитаты от этого не меняется.
export function normQuote(s: string): string {
  return s
    .replace(/[«»“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ё/gi, (c) => (c === 'Ё' ? 'Е' : 'е'))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Цитата подтверждена, если после нормализации целиком входит в текст
// статьи. Пустую цитату не подтверждаем — «без цитаты вывода нет».
export function quoteInText(quote: string, text: string): boolean {
  const q = normQuote(quote);
  return q.length > 0 && normQuote(text).includes(q);
}

// Id статьи — `КОД:ст.N` (код акта в «Әділет» латиницей, N может быть
// «44-1»). LLM — не граница безопасности: модель пишет «ст. 122», кириллическую
// «К» или пробелы вокруг двоеточия — приводим к каноническому виду, а
// существование статьи всё равно проверяет БД.
export function normalizeArticleId(raw: string): string {
  const m = /^\s*([KZКЗ][0-9A-Za-z_]+)\s*:\s*(?:ст\.?|статья)\s*([0-9]+(?:-[0-9]+)?)\s*$/i.exec(raw);
  if (!m) return raw.trim();
  const code = m[1].replace(/^К/i, 'K').replace(/^З/i, 'Z').toUpperCase();
  return `${code}:ст.${m[2]}`;
}

// Слова запроса для запасного поиска «любое из слов», когда строгий
// websearch_to_tsquery (все слова) ничего не нашёл.
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\d]{3,}/gu) ?? [])];
}

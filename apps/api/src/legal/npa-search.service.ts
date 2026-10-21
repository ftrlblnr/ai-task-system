import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeArticleId, quoteInText, queryWords } from './npa-text';

// Поиск по базе НПА для агента-юриста — порт find/get/verify/term из
// legal-agent/tools/search_npa.py на Postgres (tsvector со словарём russian
// вместо SQLite FTS с «грубой основой слова»).

export interface NpaHit {
  id: string;
  code: string;
  short: string;
  title: string;
  snippet: string;
}

export interface NpaArticleView {
  id: string;
  code: string;
  short: string;
  documentTitle: string;
  requisites: string;
  url: string;
  article: string;
  title: string;
  path: string[];
  text: string;
  footnotes: string[];
  excluded: boolean;
  pendingFrom: string[];
  expiresOn: string[];
}

export interface NpaTermHit {
  term: string;
  articleId: string;
  definition: string;
}

const MAX_LIMIT = 30;
const TERM_LIMIT = 20;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class NpaSearchService {
  constructor(private readonly prisma: PrismaService) {}

  // Сначала все слова запроса (websearch_to_tsquery — как поиск в
  // интернете: кавычки = фраза, минус = исключить); пусто — любое из слов,
  // чтобы агент получил хоть что-то и переформулировал сам.
  async find(query: string, opts: { code?: string; limit?: number } = {}): Promise<NpaHit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), MAX_LIMIT);
    const strict = await this.search(query, opts.code, limit);
    if (strict.length > 0) return strict;
    const words = queryWords(query);
    if (words.length < 2) return strict;
    return this.search(words.join(' or '), opts.code, limit);
  }

  private search(query: string, code: string | undefined, limit: number): Promise<NpaHit[]> {
    const byCode = code ? Prisma.sql`AND a."code" = ${code}` : Prisma.empty;
    // ts_headline дорогой на длинных статьях (до ~50 тыс. символов) —
    // считаем его только для уже отобранных LIMIT строк.
    return this.prisma.$queryRaw<NpaHit[]>`
      WITH q AS (SELECT websearch_to_tsquery('russian', ${query}) AS q),
      top AS (
        SELECT a."id", a."code", a."title", a."text", ts_rank(a."search", q.q) AS rank
        FROM "NpaArticle" a, q
        WHERE a."search" @@ q.q AND NOT a."excluded" ${byCode}
        ORDER BY rank DESC, a."id"
        LIMIT ${limit}
      )
      SELECT top."id", top."code", d."short", top."title",
        ts_headline('russian', top."text", q.q,
          'StartSel=[, StopSel=], MaxFragments=2, MaxWords=30, MinWords=12, FragmentDelimiter=" … "') AS "snippet"
      FROM top JOIN "NpaDocument" d ON d."code" = top."code", q
      ORDER BY top.rank DESC, top."id"`;
  }

  async getArticle(rawId: string): Promise<NpaArticleView | null> {
    const id = normalizeArticleId(rawId);
    const a = await this.prisma.npaArticle.findUnique({ where: { id }, include: { document: true } });
    if (!a) return null;
    return {
      id: a.id,
      code: a.code,
      short: a.document.short,
      documentTitle: a.document.title,
      requisites: a.document.requisites,
      url: a.document.url,
      article: a.article,
      title: a.title,
      path: a.path,
      text: a.text,
      footnotes: a.footnotes,
      excluded: a.excluded,
      pendingFrom: a.pendingFrom.map(isoDate),
      expiresOn: a.expiresOn.map(isoDate),
    };
  }

  // exists=false — статьи нет в базе (ошибка id), verified=false при
  // exists=true — цитаты нет в тексте статьи. Агенту нужны оба различия.
  async verifyQuote(rawId: string, quote: string): Promise<{ id: string; exists: boolean; verified: boolean }> {
    const id = normalizeArticleId(rawId);
    const a = await this.prisma.npaArticle.findUnique({ where: { id }, select: { text: true } });
    return { id, exists: !!a, verified: !!a && quoteInText(quote, a.text) };
  }

  async term(q: string): Promise<NpaTermHit[]> {
    const needle = q.trim();
    if (!needle) return [];
    const rows = await this.prisma.npaGlossaryTerm.findMany({
      where: { term: { contains: needle, mode: 'insensitive' } },
      orderBy: [{ term: 'asc' }],
      take: TERM_LIMIT,
      select: { term: true, articleId: true, definition: true },
    });
    return rows;
  }
}

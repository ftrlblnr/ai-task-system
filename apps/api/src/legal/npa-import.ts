import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { Prisma, PrismaClient } from '@prisma/client';

// Импорт базы НПА из legal-data/npa-data.jsonl.gz (строки kind: document |
// article | glossary, выгрузка «Әділет» из комплекта агента-юриста).
//   npm run legal:import --workspace=apps/api [-- путь/к/файлу.jsonl.gz]
// На проде: docker exec -w /repo/apps/api docker-api-1 npm run legal:import
//
// Файл — полная база, поэтому повторный импорт = замена: акты upsert, статьи
// и глоссарий актов из файла пересоздаются, акты, которых в файле нет,
// удаляются. Всё в одной транзакции — поиск агента никогда не видит
// полубазу. Файл читается потоком дважды (статьи, затем глоссарий — так
// порядок строк в файле не важен), в памяти только пачка строк: контейнер
// api ограничен 512 МБ, а распакованная база ~25 МБ текста.

const BATCH = 200;

interface DocumentRecord {
  kind: 'document';
  code: string;
  short: string;
  title: string;
  requisites: string;
  url: string;
  last_amendment?: { date?: string | null; act?: string | null } | null;
  source_date?: string | null;
}

interface ArticleRecord {
  kind: 'article';
  id: string;
  code: string;
  article: string;
  title: string;
  path: string[];
  text: string;
  footnotes: string[];
  excluded: boolean;
  amended_by: unknown[];
  pending_from: string[];
  expires_on: string[];
  links: string[];
  watch: string[];
}

interface GlossaryRecord {
  kind: 'glossary';
  article_id: string;
  code: string;
  term: string;
  definition: string;
}

export type NpaRecord = DocumentRecord | ArticleRecord | GlossaryRecord;

export interface ImportStats {
  documents: number;
  articles: number;
  terms: number;
  removedDocuments: number;
}

// Даты выгрузки — 'YYYY-MM-DD' (колонки @db.Date), полночь UTC.
function date(s: string | null | undefined): Date | null {
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Неверная дата в данных НПА: ${s}`);
  return new Date(`${s}T00:00:00Z`);
}

export function parseRecord(line: string): NpaRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const r = JSON.parse(trimmed) as NpaRecord;
  if (r.kind !== 'document' && r.kind !== 'article' && r.kind !== 'glossary') {
    throw new Error(`Неизвестный kind в данных НПА: ${String((r as { kind?: unknown }).kind)}`);
  }
  return r;
}

export interface NpaDocumentRow {
  code: string;
  short: string;
  title: string;
  requisites: string;
  url: string;
  lastAmendmentDate: Date | null;
  lastAmendmentAct: string | null;
  sourceDate: Date | null;
}

export function toDocumentRow(r: DocumentRecord): NpaDocumentRow {
  return {
    code: r.code,
    short: r.short,
    title: r.title,
    requisites: r.requisites ?? '',
    url: r.url ?? '',
    lastAmendmentDate: date(r.last_amendment?.date),
    lastAmendmentAct: r.last_amendment?.act ?? null,
    sourceDate: date(r.source_date),
  };
}

export function toArticleRow(r: ArticleRecord): Prisma.NpaArticleCreateManyInput {
  return {
    id: r.id,
    code: r.code,
    article: r.article,
    title: r.title ?? '',
    path: r.path ?? [],
    text: r.text ?? '',
    footnotes: r.footnotes ?? [],
    excluded: !!r.excluded,
    amendedBy: (r.amended_by ?? []) as Prisma.InputJsonValue,
    pendingFrom: (r.pending_from ?? []).map((d) => date(d) as Date),
    expiresOn: (r.expires_on ?? []).map((d) => date(d) as Date),
    links: r.links ?? [],
    watch: r.watch ?? [],
  };
}

export function toTermRow(r: GlossaryRecord): Prisma.NpaGlossaryTermCreateManyInput {
  return { articleId: r.article_id, code: r.code, term: r.term, definition: r.definition };
}

async function* readRecords(file: string): AsyncGenerator<NpaRecord> {
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    const r = parseRecord(line);
    if (r) yield r;
  }
}

export async function importNpa(prisma: PrismaClient, file: string): Promise<ImportStats> {
  // Акты — первым проходом: их ~20, нужны до статей (внешний ключ).
  const documents: DocumentRecord[] = [];
  for await (const r of readRecords(file)) if (r.kind === 'document') documents.push(r);
  if (documents.length === 0) throw new Error('В файле нет ни одного акта — импорт отменён, база не тронута');
  const codes = documents.map((d) => d.code);

  return prisma.$transaction(
    async (tx) => {
      const removed = await tx.npaDocument.deleteMany({ where: { code: { notIn: codes } } });
      for (const d of documents) {
        const row = toDocumentRow(d);
        await tx.npaDocument.upsert({ where: { code: d.code }, create: row, update: row });
      }
      // Каскад снимает и глоссарий этих актов.
      await tx.npaArticle.deleteMany({ where: { code: { in: codes } } });

      let articles = 0;
      let batch: Prisma.NpaArticleCreateManyInput[] = [];
      for await (const r of readRecords(file)) {
        if (r.kind !== 'article') continue;
        batch.push(toArticleRow(r));
        if (batch.length >= BATCH) {
          articles += (await tx.npaArticle.createMany({ data: batch })).count;
          batch = [];
        }
      }
      if (batch.length) articles += (await tx.npaArticle.createMany({ data: batch })).count;

      let terms = 0;
      let termBatch: Prisma.NpaGlossaryTermCreateManyInput[] = [];
      for await (const r of readRecords(file)) {
        if (r.kind !== 'glossary') continue;
        termBatch.push(toTermRow(r));
        if (termBatch.length >= BATCH) {
          terms += (await tx.npaGlossaryTerm.createMany({ data: termBatch })).count;
          termBatch = [];
        }
      }
      if (termBatch.length) terms += (await tx.npaGlossaryTerm.createMany({ data: termBatch })).count;

      return { documents: documents.length, articles, terms, removedDocuments: removed.count };
    },
    // Вставка ~6 тыс. статей с расчётом tsvector занимает десятки секунд —
    // дефолтные 5 с интерактивной транзакции Prisma не хватает.
    { timeout: 10 * 60 * 1000, maxWait: 30 * 1000 },
  );
}

async function main() {
  const file = resolve(process.cwd(), process.argv[2] ?? 'legal-data/npa-data.jsonl.gz');
  const prisma = new PrismaClient();
  const started = Date.now();
  try {
    const s = await importNpa(prisma, file);
    console.log(
      `База НПА загружена из ${file}: актов ${s.documents}, статей ${s.articles}, терминов ${s.terms}` +
        `${s.removedDocuments ? `, удалено актов, которых нет в файле: ${s.removedDocuments}` : ''}` +
        ` (${Math.round((Date.now() - started) / 1000)} с)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Импорт базы НПА не выполнен:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

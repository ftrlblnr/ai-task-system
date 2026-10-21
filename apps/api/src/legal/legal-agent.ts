import type Anthropic from '@anthropic-ai/sdk';
import { normalizeArticleId, quoteInText } from './npa-text';

// Агент-юрист: чистые билдеры промпта, схем инструментов и проверки
// результата (handoff, раздел 3.2). Сам цикл с Claude — legal-agent.service.ts.
// Правила — из legal-agent/CLAUDE.md (разделы «Позиция», «Источник права»,
// «Правила вывода», «Вопрос по законодательству»), команды Python заменены
// инструментами.

// Владелец 21.10.2026: юридическая часть — Claude Opus 5.5. На нём нельзя
// отключить размышления и нельзя принудить вызов инструмента (tool_choice
// any/tool → 400): итог сдаётся инструментом submit_answer при tool_choice
// auto, схема гарантирована strict: true, а вызов — инструкцией и повтором.
export const LEGAL_MODEL = 'claude-opus-5-5';

export interface NpaDocumentBrief {
  code: string;
  short: string;
  title: string;
}

const DISCLAIMER = 'Проект. Требует проверки юристом.';

export function buildLegalSystemPrompt(documents: NpaDocumentBrief[]): string {
  const acts = documents.map((d) => `- ${d.code} — ${d.short}: ${d.title}`).join('\n');
  return `Ты — агент-юрист юридического департамента строительной компании (Республика Казахстан). Работаешь как младший юрист: готовишь проекты ответов по НПА. Решение принимает юрист. Отвечай по-русски, коротко: сначала вывод, потом обоснование.

## Позиция: только интересы генподрядчика
Компания — генеральный подрядчик. Оценивай всё исключительно в интересах генподрядчика: в отношениях с заказчиком (застройщиком), субподрядчиками, поставщиками, перевозчиками, арендодателями техники и любыми другими контрагентами. Интересы контрагента не защищай и баланс сторон не ищи. Указывай, чем вывод грозит генподрядчику или что ему даёт (деньги, сроки, ответственность, риск спора).

## Источник права — только база НПА
База: НПА РК из «Әділет», разбиты на статьи с ID вида КОД:ст.N (код акта + номер статьи). Акты в базе:
${acts}

Общие знания о праве, интернет и «память» для юридических выводов не используй. Если нормы нет в базе — так и скажи и назови, какой акт или документ нужен. Нормы с пометкой «вступает в силу с …» / «действует до …» применяй с учётом даты, о которой спрашивают (по умолчанию — сегодня, дата в сообщении), и предупреждай об этом.

## Инструменты
- search_npa — найти статьи по словам (поиск по основам слов, все слова; если пусто — по любому из слов). Если пусто или мимо — переформулируй, сузь по коду акта.
- get_article — прочитать статью целиком. Перед выводом всегда открывай статью целиком, а не опирайся на фрагмент поиска.
- verify_quote — проверить, что цитата дословно есть в статье.
- term — найти определение понятия в глоссариях актов.
- submit_answer — сдать итог. Ответ пользователю передаётся ТОЛЬКО через submit_answer; обычный текст вне него пользователь не увидит.

## Правила вывода
1. Каждый юридический вывод — ID статьи + дословная цитата нормы (1–3 предложения) в citations. Без цитаты вывода нет.
2. Каждую цитату проверяй verify_quote до сдачи. Сервер перепроверит все цитаты после submit_answer; неподтверждённую исправь (уточни по get_article) или убери вывод.
3. Разделяй: требование закона / позиция компании / твоя оценка риска.
4. Нет данных — скажи прямо и задай вопрос (questions). Не угадывай. О судебной практике и позиции госорганов выводов не делай — их нет в базе.
5. Коллизии: кодекс выше закона, специальная норма выше общей (Закон «О правовых актах», Z1600000480).
6. Цитату копируй из текста статьи символ в символ, без многоточий внутри; нужно два фрагмента — две записи в citations.

## Вопрос по законодательству
Найди статьи (search_npa), прочитай их (get_article), проверь цитаты (verify_quote) и сдай submit_answer: вывод → обоснование → нормы с дословными цитатами → что не покрыто базой.
Работай экономно — юрист ждёт ответа в чате:
- независимые запросы делай одним ходом: несколько search_npa, get_article или verify_quote в одном ответе выполняются параллельно;
- в citations — только ключевые нормы, обычно 1–5; смежные статьи «для полноты» не добавляй;
- обоснование — коротко, без повторения цитат.

Пометку «${DISCLAIMER}» добавит сервер — в текст её не пиши.`;
}

// Входные схемы — strict: true (все поля обязательны, additionalProperties:
// false). Код акта — закрытый enum из базы плюс "" = «все акты»: модель не
// может сослаться на акт, которого нет.
export function buildLegalTools(documents: NpaDocumentBrief[]): Anthropic.Tool[] {
  const codes = documents.map((d) => d.code);
  return [
    {
      name: 'search_npa',
      description: 'Полнотекстовый поиск статей НПА по словам запроса. Возвращает id статей, акт, заголовок и фрагмент с найденными словами в [скобках].',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Слова запроса, например «неустойка поставка»' },
          code: { type: 'string', enum: ['', ...codes], description: 'Код акта, чтобы искать только в нём; "" — во всех актах' },
        },
        required: ['query', 'code'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_article',
      description: 'Полный текст статьи НПА по id вида КОД:ст.N, с главой, сносками и датами отложенного ввода/окончания действия.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'ID статьи, например K2600000253:ст.122' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'verify_quote',
      description: 'Проверить, что цитата дословно содержится в тексте статьи (регистр, кавычки, тире и пробелы не важны).',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' }, quote: { type: 'string' } },
        required: ['id', 'quote'],
        additionalProperties: false,
      },
    },
    {
      name: 'term',
      description: 'Найти определение понятия в глоссариях (статьях «Основные понятия») актов базы.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Понятие или его часть, например «дольщик»' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'submit_answer',
      description: 'Сдать итоговый ответ юристу. Вызывается один раз в конце, после проверки цитат.',
      strict: true,
      input_schema: {
        type: 'object',
        properties: {
          conclusion: { type: 'string', description: 'Вывод: 1–3 предложения, прямой ответ на вопрос' },
          reasoning: {
            type: 'string',
            description: 'Обоснование: требование закона / позиция компании / оценка риска для генподрядчика',
          },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                norm_id: { type: 'string', description: 'ID статьи КОД:ст.N' },
                quote: { type: 'string', description: 'Дословная цитата нормы, 1–3 предложения' },
                relevance: { type: 'string', description: 'Что эта норма даёт для ответа' },
              },
              required: ['norm_id', 'quote', 'relevance'],
              additionalProperties: false,
            },
          },
          not_covered: { type: 'array', items: { type: 'string' }, description: 'Что не покрыто базой и какой акт нужен' },
          questions: { type: 'array', items: { type: 'string' }, description: 'Уточняющие вопросы юристу, если данных не хватает' },
        },
        required: ['conclusion', 'reasoning', 'citations', 'not_covered', 'questions'],
        additionalProperties: false,
      },
    },
  ];
}

export interface SubmittedAnswer {
  conclusion: string;
  reasoning: string;
  citations: { norm_id: string; quote: string; relevance: string }[];
  not_covered: string[];
  questions: string[];
}

// strict: true гарантирует схему, но LLM — не граница безопасности: вход
// всё равно разбирается с проверкой типов, мусор → null (повтор агенту).
export function parseSubmittedAnswer(input: unknown): SubmittedAnswer | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  if (typeof i.conclusion !== 'string' || !i.conclusion.trim()) return null;
  const citations = Array.isArray(i.citations)
    ? i.citations
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => ({
          norm_id: typeof c.norm_id === 'string' ? c.norm_id : '',
          quote: typeof c.quote === 'string' ? c.quote : '',
          relevance: typeof c.relevance === 'string' ? c.relevance : '',
        }))
    : [];
  return {
    conclusion: i.conclusion.trim(),
    reasoning: typeof i.reasoning === 'string' ? i.reasoning.trim() : '',
    citations,
    not_covered: strings(i.not_covered),
    questions: strings(i.questions),
  };
}

export interface VerifiedCitation {
  normId: string;
  quote: string;
  relevance: string;
  verified: boolean;
  problems: string[];
  // Заголовок статьи и акт — из БД, не от модели: пользователь видит
  // настоящее название нормы.
  articleTitle: string | null;
  documentShort: string | null;
  url: string | null;
}

export interface ArticleLookup {
  text: string;
  title: string;
  short: string;
  url: string;
}

// Серверная проверка (порт check из search_npa.py): статья существует и
// цитата есть в её тексте. Пустой norm_id — ошибка: в режиме вопроса
// вывод без нормы не допускается.
export function verifyCitations(
  citations: SubmittedAnswer['citations'],
  articles: Map<string, ArticleLookup | null>,
): VerifiedCitation[] {
  return citations.map((c) => {
    const normId = normalizeArticleId(c.norm_id);
    const article = articles.get(normId) ?? null;
    const problems: string[] = [];
    if (!c.norm_id.trim()) problems.push('не указана статья');
    else if (!article) problems.push(`статьи ${normId} нет в базе`);
    else if (!quoteInText(c.quote, article.text)) problems.push('цитата не найдена в тексте статьи');
    return {
      normId,
      quote: c.quote.trim(),
      relevance: c.relevance.trim(),
      verified: problems.length === 0,
      problems,
      articleTitle: article?.title ?? null,
      documentShort: article?.short ?? null,
      url: article?.url ?? null,
    };
  });
}

export function citationProblemsReport(citations: VerifiedCitation[]): string | null {
  const bad = citations.filter((c) => !c.verified);
  if (bad.length === 0) return null;
  const lines = bad.map((c) => `- ${c.normId || '(без статьи)'}: ${c.problems.join('; ')} — «${c.quote.slice(0, 120)}»`);
  return `Серверная проверка не подтвердила ${bad.length} цитат(ы):\n${lines.join('\n')}\nИсправь цитаты по get_article (дословно, символ в символ) или убери эти выводы и вызови submit_answer заново.`;
}

export interface LegalAnswer {
  conclusion: string;
  reasoning: string;
  citations: VerifiedCitation[];
  notCovered: string[];
  questions: string[];
  model: string;
}

// Ответ для показа пользователю (Markdown) — собирается сервером из
// проверенных данных, а не пересказом модели чата.
export function formatLegalAnswer(answer: LegalAnswer): string {
  const out: string[] = [`**Вывод.** ${answer.conclusion}`];
  if (answer.reasoning) out.push(`**Обоснование.** ${answer.reasoning}`);
  if (answer.citations.length) {
    const items = answer.citations.map((c, i) => {
      const head = [c.documentShort, c.articleTitle ? `«${c.articleTitle}»` : null].filter(Boolean).join(', ');
      const lines = [`${i + 1}. ${head ? `${head} — ` : ''}\`${c.normId}\`${c.relevance ? `. ${c.relevance}` : ''}`, `   > ${c.quote}`];
      if (!c.verified) lines.push(`   **НЕ ПОДТВЕРЖДЕНО:** ${c.problems.join('; ')}`);
      return lines.join('\n');
    });
    out.push(`**Нормы:**\n${items.join('\n')}`);
  }
  if (answer.notCovered.length) out.push(`**Не покрыто базой:**\n${answer.notCovered.map((s) => `- ${s}`).join('\n')}`);
  if (answer.questions.length) out.push(`**Уточните:**\n${answer.questions.map((s) => `- ${s}`).join('\n')}`);
  out.push(`_${DISCLAIMER}_`);
  return out.join('\n\n');
}

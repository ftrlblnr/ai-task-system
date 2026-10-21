import type Anthropic from '@anthropic-ai/sdk';
import { normalizeArticleId, normQuote, quoteInText } from './npa-text';

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

export const RISK_LEVELS = ['высокий', 'средний', 'низкий'] as const;
export const FINDING_TYPES = [
  'условие против ГП',
  'выгодное ГП условие недействительно',
  'не хватает защиты ГП',
  'несоответствие НПА',
  'устаревшая ссылка',
  'отсутствует обязательное условие',
  'внутреннее противоречие',
  'коммерческий риск',
] as const;

const ASK_SECTION = `## Вопрос по законодательству
Найди статьи (search_npa), прочитай их (get_article), проверь цитаты (verify_quote) и сдай submit_answer: вывод → обоснование → нормы с дословными цитатами → что не покрыто базой.
Работай экономно — юрист ждёт ответа в чате:
- независимые запросы делай одним ходом: несколько search_npa, get_article или verify_quote в одном ответе выполняются параллельно;
- в citations — только ключевые нормы, обычно 1–5; смежные статьи «для полноты» не добавляй;
- обоснование — коротко, без повторения цитат.`;

// Разбор договора — раздел «Разбор договора» legal-agent/CLAUDE.md; файл уже
// превращён сервером в текст и лежит в первом сообщении.
const REVIEW_SECTION = `## Разбор договора
Текст договора — в первом сообщении между <contract> и </contract>, уже извлечён из файла. Прочитай его полностью, включая приложения.
1. Определи роль генподрядчика в этом договоре и контрагента. Если юрист указал, на что обратить особое внимание, — начни с этого.
2. Определи вид договора и применимые акты.
3. Проверь: императивные нормы ГК по виду договора; полномочия подписантов (Z980000220_); форму и нотариат; подсудность и претензионный порядок (K1500000377); неустойку, убытки, ограничение ответственности, расторжение, сроки; гарантии (для строительства — ст. 122 Строительного кодекса K2600000253); налоговые оговорки по новому Налоговому кодексу K2500000214 (НК 2017 г. утратил силу); персональные данные физлиц (Z1300000094); ссылки на утратившие силу акты; внутренние противоречия договора. Коммерческие риски для генподрядчика — отдельно от несоответствий закону.
4. Ищи: (а) условия, ухудшающие положение генподрядчика; (б) отсутствующие условия, которые защитили бы генподрядчика; (в) условия в пользу генподрядчика, противоречащие императивной норме — суд их не применит, предложи самую сильную для генподрядчика формулировку, которая выдержит проверку законом; (г) нарушения закона, грозящие генподрядчику санкциями или недействительностью сделки. Не предлагай правок, улучшающих положение контрагента, если они не нужны для законности условия; законное выгодное генподрядчику условие не трогай. Смотри цепочку: обязательства генподрядчика перед заказчиком должны быть «прикрыты» обязательствами субподрядчиков и поставщиков (сроки, гарантии, неустойки, качество, ответственность за вред) — разрыв в пользу контрагента всегда находка.
5. Сдай submit_review: не больше ~25 находок, самые рискованные — первыми. as_is — дословный фрагмент договора (сервер ищет его в тексте договора; для отсутствующего условия напиши «отсутствует»). В каждой находке gc_impact — чем это грозит генподрядчику или что даёт. Для коммерческого риска без нормы norm_id и quote оставь пустыми строками.
Работай экономно: независимые запросы (несколько search_npa / get_article / verify_quote) делай одним ходом — они выполняются параллельно.`;

export type LegalMode = 'ask' | 'review';

export function buildLegalSystemPrompt(documents: NpaDocumentBrief[], mode: LegalMode = 'ask'): string {
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
- ${mode === 'ask' ? 'submit_answer' : 'submit_review'} — сдать итог. Результат передаётся юристу ТОЛЬКО через этот инструмент; обычный текст вне него юрист не увидит.

## Правила вывода
1. Каждый юридический вывод — ID статьи + дословная цитата нормы (1–3 предложения) в citations. Без цитаты вывода нет.
2. Каждую цитату проверяй verify_quote до сдачи. Сервер перепроверит все цитаты после сдачи итога; неподтверждённую исправь (уточни по get_article) или убери вывод.
3. Разделяй: требование закона / позиция компании / твоя оценка риска.
4. Нет данных — скажи прямо и задай вопрос (questions). Не угадывай. О судебной практике и позиции госорганов выводов не делай — их нет в базе.
5. Коллизии: кодекс выше закона, специальная норма выше общей (Закон «О правовых актах», Z1600000480).
6. Цитату копируй из текста статьи символ в символ, без многоточий внутри; нужно два фрагмента — две записи в citations.

${mode === 'ask' ? ASK_SECTION : REVIEW_SECTION}

Пометку «${DISCLAIMER}» добавит сервер — в текст её не пиши.`;
}

// Входные схемы — strict: true (все поля обязательны, additionalProperties:
// false). Код акта — закрытый enum из базы плюс "" = «все акты»: модель не
// может сослаться на акт, которого нет.
export function buildLegalTools(documents: NpaDocumentBrief[], mode: LegalMode = 'ask'): Anthropic.Tool[] {
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
    mode === 'ask' ? SUBMIT_ANSWER_TOOL : SUBMIT_REVIEW_TOOL,
  ];
}

const SUBMIT_ANSWER_TOOL: Anthropic.Tool = {
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
};

const str = (description: string) => ({ type: 'string', description });

const SUBMIT_REVIEW_TOOL: Anthropic.Tool = {
  name: 'submit_review',
  description: 'Сдать итоговый разбор договора. Вызывается один раз в конце, после проверки цитат.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      contract: str('Название договора (вид, стороны, номер/дата, если есть)'),
      gc_role: str('Роль генподрядчика в этом договоре и контрагент — одной строкой'),
      applicable_acts: str('Вид договора и применимые акты — одной строкой'),
      summary: str('Общий вывод, 3–5 предложений'),
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            clause: str('Пункт договора, например «п. 5.2»'),
            as_is: str('Дословный фрагмент договора; для отсутствующего условия — «отсутствует»'),
            proposed: str('Редакция в пользу генподрядчика'),
            reasoning: str('Обоснование'),
            gc_impact: str('Чем это грозит генподрядчику или что даёт'),
            norm_id: str('ID статьи КОД:ст.N; пусто для коммерческого риска без нормы'),
            quote: str('Дословная цитата нормы; пусто, если norm_id пуст'),
            risk: { type: 'string', enum: [...RISK_LEVELS] },
            type: { type: 'string', enum: [...FINDING_TYPES] },
          },
          required: ['clause', 'as_is', 'proposed', 'reasoning', 'gc_impact', 'norm_id', 'quote', 'risk', 'type'],
          additionalProperties: false,
        },
      },
      general_issues: { type: 'array', items: { type: 'string' }, description: 'Общие проблемы договора в целом (не по пунктам)' },
      not_checked: { type: 'array', items: { type: 'string' }, description: 'Что не удалось проверить по базе' },
    },
    required: ['contract', 'gc_role', 'applicable_acts', 'summary', 'findings', 'general_issues', 'not_checked'],
    additionalProperties: false,
  },
};

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

// ---------- Разбор договора ----------

export type RiskLevel = (typeof RISK_LEVELS)[number];
export type FindingType = (typeof FINDING_TYPES)[number];

export interface SubmittedFinding {
  clause: string;
  as_is: string;
  proposed: string;
  reasoning: string;
  gc_impact: string;
  norm_id: string;
  quote: string;
  risk: RiskLevel;
  type: FindingType;
}

export interface SubmittedReview {
  contract: string;
  gc_role: string;
  applicable_acts: string;
  summary: string;
  findings: SubmittedFinding[];
  general_issues: string[];
  not_checked: string[];
}

export function parseSubmittedReview(input: unknown): SubmittedReview | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);
  if (!text(i.summary) || !Array.isArray(i.findings)) return null;
  const findings = i.findings
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      clause: text(f.clause),
      as_is: text(f.as_is),
      proposed: text(f.proposed),
      reasoning: text(f.reasoning),
      gc_impact: text(f.gc_impact),
      norm_id: text(f.norm_id),
      quote: text(f.quote),
      risk: (RISK_LEVELS as readonly string[]).includes(f.risk as string) ? (f.risk as RiskLevel) : 'средний',
      type: (FINDING_TYPES as readonly string[]).includes(f.type as string) ? (f.type as FindingType) : 'коммерческий риск',
    }));
  return {
    contract: text(i.contract),
    gc_role: text(i.gc_role),
    applicable_acts: text(i.applicable_acts),
    summary: text(i.summary),
    findings,
    general_issues: strings(i.general_issues),
    not_checked: strings(i.not_checked),
  };
}

// Сравнение фрагмента договора — без пробелов вовсе: pdfjs склеивает
// строки PDF и рвёт слова пробелами по-своему, а модель цитирует «как
// читается». Ложное совпадение 60 символов без пробелов практически исключено.
function compact(s: string): string {
  return normQuote(s).replace(/\s+/g, '');
}

// Порт check из search_npa.py: фрагмент «как есть» режется по многоточиям,
// «/» и «;»; достаточно, чтобы хоть одна часть длиннее 15 символов нашлась
// в договоре (первые 60 символов). Короткие («отсутствует») не проверяются.
export function asIsFoundInContract(asIs: string, compactContract: string): boolean {
  const parts = asIs
    .split(/\s*(?:…|\.\.\.|\/|;)\s*/)
    .map((x) => x.replace(/^[\s«»"]+|[\s«»"]+$/g, ''))
    .filter((x) => x.length > 15);
  if (parts.length === 0) return true;
  return parts.some((x) => compactContract.includes(compact(x).slice(0, 60)));
}

export interface VerifiedFinding extends SubmittedFinding {
  verified: boolean;
  problems: string[];
  articleTitle: string | null;
  documentShort: string | null;
}

export function verifyFindings(
  findings: SubmittedFinding[],
  articles: Map<string, ArticleLookup | null>,
  contractText: string,
): VerifiedFinding[] {
  const contract = compact(contractText);
  return findings.map((f) => {
    const problems: string[] = [];
    const normId = f.norm_id ? normalizeArticleId(f.norm_id) : '';
    const article = normId ? (articles.get(normId) ?? null) : null;
    if (normId) {
      if (!article) problems.push(`статьи ${normId} нет в базе`);
      else if (!f.quote || !quoteInText(f.quote, article.text)) problems.push('цитата нормы не найдена в статье');
    }
    if (f.as_is && !asIsFoundInContract(f.as_is, contract)) problems.push('фрагмент «как есть» не найден в договоре');
    return {
      ...f,
      norm_id: normId,
      verified: problems.length === 0,
      problems,
      articleTitle: article?.title ?? null,
      documentShort: article?.short ?? null,
    };
  });
}

export function findingProblemsReport(findings: VerifiedFinding[]): string | null {
  const bad = findings.map((f, i) => ({ f, n: i + 1 })).filter(({ f }) => !f.verified);
  if (bad.length === 0) return null;
  const lines = bad.map(({ f, n }) => `- находка ${n} (${f.clause || 'без пункта'}): ${f.problems.join('; ')}`);
  return `Серверная проверка не подтвердила ${bad.length} из ${findings.length} находок:\n${lines.join('\n')}\nИсправь цитаты по get_article и фрагменты «как есть» по тексту договора (дословно) или убери эти находки, затем вызови submit_review заново со ВСЕМИ находками.`;
}

export interface LegalReview {
  contract: string;
  gcRole: string;
  applicableActs: string;
  summary: string;
  findings: VerifiedFinding[];
  generalIssues: string[];
  notChecked: string[];
  model: string;
}

const RISK_ORDER: Record<RiskLevel, number> = { высокий: 0, средний: 1, низкий: 2 };

// Самые рискованные — первыми (стабильно внутри уровня риска).
export function sortFindings<T extends { risk: RiskLevel }>(findings: T[]): T[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => RISK_ORDER[a.f.risk] - RISK_ORDER[b.f.risk] || a.i - b.i)
    .map(({ f }) => f);
}

export function riskCounts(findings: { risk: RiskLevel }[]): Record<RiskLevel, number> {
  return {
    высокий: findings.filter((f) => f.risk === 'высокий').length,
    средний: findings.filter((f) => f.risk === 'средний').length,
    низкий: findings.filter((f) => f.risk === 'низкий').length,
  };
}

// Короткий итог для беседы ассистента: число находок по рискам и 5 главных.
export function formatReviewSummary(review: LegalReview, fileName: string): string {
  const c = riskCounts(review.findings);
  const unverified = review.findings.filter((f) => !f.verified).length;
  const top = sortFindings(review.findings)
    .slice(0, 5)
    .map((f, i) => `${i + 1}. **${f.clause || 'Договор в целом'}** (${f.risk}) — ${f.gc_impact || f.reasoning}`);
  const out = [
    `**Разбор договора «${fileName}» готов.** Находок: ${review.findings.length} (высокий риск — ${c['высокий']}, средний — ${c['средний']}, низкий — ${c['низкий']}).`,
  ];
  if (review.gcRole) out.push(`Роль генподрядчика: ${review.gcRole}`);
  out.push(review.summary);
  if (top.length) out.push(`**Главное:**\n${top.join('\n')}`);
  if (unverified) out.push(`**Не подтверждено проверкой по базе: ${unverified}** — отмечены в отчёте.`);
  out.push(`Полный отчёт с правками и цитатами норм — в файле ниже. _${DISCLAIMER}_`);
  return out.join('\n\n');
}

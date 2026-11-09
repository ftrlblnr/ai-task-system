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
  'финансовое условие',
] as const;

// Финансовая оценка и проверка контрагента (ноябрь 2026): договор
// оценивается не только на законность, но и на деньги для генподрядчика, а
// контрагент — по открытым источникам (серверные web_search / web_fetch).
export const FINANCIAL_VERDICTS = ['выгоден', 'сбалансирован', 'невыгоден', 'крайне невыгоден'] as const;
export const TERM_ASSESSMENTS = ['выгодно', 'нейтрально', 'невыгодно', 'отсутствует'] as const;
export const NEGOTIATION_PRIORITIES = ['обязательно', 'желательно', 'можно уступить'] as const;
export const COUNTERPARTY_VERDICTS = ['рисков не выявлено', 'есть риски', 'высокий риск', 'не удалось проверить'] as const;

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
5. Финансовая оценка (поле financial) — насколько договор выгоден генподрядчику в деньгах. Сначала пойми, кто платит: генподрядчик получает деньги (договор с заказчиком) или платит (субподряд, поставка, аренда) — от этого зависит, что выгодно. Пройди по темам, а что в договоре не урегулировано — тоже отметь (оценка «отсутствует»):
   - цена: твёрдая / приблизительная / по смете; что в неё входит (материалы, доставка, НДС, накладные); изменение цены и индексация при росте цен и изменении объёмов; оплата дополнительных работ и порядок их согласования;
   - платежи: аванс (размер, зачёт, обеспечение), промежуточные платежи, срок оплаты после акта, гарантийное удержание (размер, срок и условия возврата, замена банковской гарантией), «оплата после оплаты заказчиком» (в договоре с субподрядчиком выгодна ГП, с заказчиком — нет);
   - кассовый разрыв (cash_flow): когда генподрядчик несёт расходы и когда получает деньги; сколько и как долго ему финансировать работы за свой счёт;
   - ответственность (liability_balance): неустойки обеих сторон — ставка, база (вся цена или просроченная часть), потолок; есть ли ответственность контрагента вообще; ограничение ответственности (реальный ущерб, упущенная выгода, общий потолок); удержание из оплаты и зачёт;
   - обеспечение: банковские гарантии и залоги, их стоимость для ГП;
   - налоги и валюта: НДС сверх цены или включён, ЭСФ и вычеты, курсовой риск;
   - приёмка: сроки подписания актов, мотивированный отказ, «молчаливая» приёмка — от неё зависят сроки оплаты;
   - расторжение: оплата выполненного и понесённых затрат, возврат аванса, односторонний отказ;
   - страхование, удорожание, форс-мажор, изменение законодательства.
   Денежные риски (money_risks) считай в цифрах договора формулой, например «0,1% × 500 млн тг × 30 дней = 15 млн тг»; нет цены — формула без суммы. Ориентир практики (practice) — твоя оценка обычных условий строительного подряда в РК, пиши её как оценку («обычно», «на практике»), не выдавай за норму закона или статистику.
6. Переговоры (negotiation) — по реальной практике, а не список желаний:
   - предлагай правки, которые контрагент с разумной вероятностью примет: взаимность (зеркальная неустойка), потолки, конкретные сроки, банковская гарантия вместо удержания, поэтапная оплата;
   - приоритет: «обязательно» — без этого подписывать опасно; «желательно» — заметно улучшает деньги или риски; «можно уступить» — разменная монета в торге. «Обязательно» — не больше 5–7 пунктов;
   - для каждой важной правки — запасная позиция (fallback) и аргумент, понятный другой стороне;
   - если договор заключается по Закону о государственных закупках, по типовой форме или с крупным заказчиком, который правок не принимает, — так и скажи в financial.verdict_reason и предлагай управление рисками: протокол разногласий (где он допустим), допсоглашения, документирование изменений и простоев, претензии в срок, контроль графика платежей.
7. Проверка контрагента (counterparty) — по открытым источникам через web_search и web_fetch: регистрация и статус (действует, ликвидация, реорганизация, банкротство), руководитель и учредители, налоговая задолженность и признание бездействующим, реестр недобросовестных участников госзакупок, судебные споры и исполнительные производства, лицензии и категории (для строительства), новости о срывах сроков и конфликтах. Ищи по БИН и по названию. Правила:
   - интернет — только для фактов о контрагенте; юридические выводы по-прежнему только по базе НПА;
   - каждый факт — с url страницы, которую ты действительно открыл или получил в результатах поиска (сервер сверит адреса); без источника факт не пиши;
   - «не нашёл» ≠ «чисто»: что не удалось проверить (сайт недоступен, нужна авторизация, нет данных) — в not_verified; госсайты РК могут быть недоступны из-за рубежа — это нормально, так и укажи;
   - тёзки: сверяй БИН, адрес, руководителя; сомнительное совпадение — не красный флаг, а «требует проверки»;
   - работай экономно: 3–6 поисков, открывай только полезные страницы.
8. Сдай submit_review: не больше ~25 находок, самые рискованные — первыми. as_is — дословный фрагмент договора (сервер ищет его в тексте договора; для отсутствующего условия напиши «отсутствует»). В каждой находке gc_impact — чем это грозит генподрядчику или что даёт, по возможности в деньгах. Для коммерческого риска или финансового условия без нормы norm_id и quote оставь пустыми строками.
Работай экономно: независимые запросы (несколько search_npa / get_article / verify_quote / web_search) делай одним ходом — они выполняются параллельно.`;

export type LegalMode = 'ask' | 'review';

export function buildLegalSystemPrompt(documents: NpaDocumentBrief[], mode: LegalMode = 'ask'): string {
  const acts = documents.map((d) => `- ${d.code} — ${d.short}: ${d.title}`).join('\n');
  return `Ты — агент-юрист юридического департамента строительной компании (Республика Казахстан). Работаешь как младший юрист: готовишь проекты ответов по НПА. Решение принимает юрист. Отвечай по-русски, коротко: сначала вывод, потом обоснование.

## Позиция: только интересы генподрядчика
Компания — генеральный подрядчик. Оценивай всё исключительно в интересах генподрядчика: в отношениях с заказчиком (застройщиком), субподрядчиками, поставщиками, перевозчиками, арендодателями техники и любыми другими контрагентами. Интересы контрагента не защищай и баланс сторон не ищи. Указывай, чем вывод грозит генподрядчику или что ему даёт (деньги, сроки, ответственность, риск спора).

## Источник права — только база НПА
База: НПА РК из «Әділет», разбиты на статьи с ID вида КОД:ст.N (код акта + номер статьи). Акты в базе:
${acts}

Общие знания о праве, интернет и «память» для юридических выводов не используй.${mode === 'review' ? ' Интернет (web_search, web_fetch) — только для фактов о контрагенте.' : ''} Если нормы нет в базе — так и скажи и назови, какой акт или документ нужен. Нормы с пометкой «вступает в силу с …» / «действует до …» применяй с учётом даты, о которой спрашивают (по умолчанию — сегодня, дата в сообщении), и предупреждай об этом.

## Инструменты
- search_npa — найти статьи по словам (поиск по основам слов, все слова; если пусто — по любому из слов). Если пусто или мимо — переформулируй, сузь по коду акта.
- get_article — прочитать статью целиком. Перед выводом всегда открывай статью целиком, а не опирайся на фрагмент поиска.
- verify_quote — проверить, что цитата дословно есть в статье.
- term — найти определение понятия в глоссариях актов.
${mode === 'review' ? '- web_search, web_fetch — поиск в интернете и чтение страницы; только для проверки контрагента.\n' : ''}- ${mode === 'ask' ? 'submit_answer' : 'submit_review'} — сдать итог. Результат передаётся юристу ТОЛЬКО через этот инструмент; обычный текст вне него юрист не увидит.

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
// Серверные инструменты Anthropic для проверки контрагента — только в
// разборе договора. Потолки — от разрастания контекста и счёта за поиск.
export const WEB_SEARCH_MAX_USES = 8;
export const WEB_FETCH_MAX_USES = 6;
const WEB_TOOLS: Anthropic.ToolUnion[] = [
  {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: WEB_SEARCH_MAX_USES,
    user_location: { type: 'approximate', country: 'KZ', timezone: 'Asia/Almaty' },
  },
  { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: WEB_FETCH_MAX_USES, max_content_tokens: 8000 },
];

export function buildLegalTools(documents: NpaDocumentBrief[], mode: LegalMode = 'ask'): Anthropic.ToolUnion[] {
  const codes = documents.map((d) => d.code);
  return [
    ...(mode === 'review' ? WEB_TOOLS : []),
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
const strList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const choice = (values: readonly string[], description: string) => ({ type: 'string', enum: [...values], description });
const objectList = (description: string, properties: Record<string, unknown>) => ({
  type: 'array',
  description,
  items: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});
const object = (description: string, properties: Record<string, unknown>) => ({
  type: 'object',
  description,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const FINANCIAL_SCHEMA = object('Финансовая оценка договора для генподрядчика', {
  verdict: choice(FINANCIAL_VERDICTS, 'Насколько договор выгоден генподрядчику в деньгах'),
  verdict_reason: str('Почему такая оценка — 2–4 предложения; можно ли вообще менять условия (госзакупки, типовая форма)'),
  gc_pays: { type: 'boolean', description: 'true — генподрядчик платит по договору, false — получает деньги' },
  price: str('Цена и модель: сумма, твёрдая/приблизительная/по смете, НДС, что входит, изменение цены'),
  cash_flow: str('Кассовый разрыв: когда ГП тратит и когда получает деньги, сколько и как долго финансирует сам'),
  liability_balance: str('Асимметрия ответственности: неустойки и потолки обеих сторон, ограничение ответственности'),
  terms: objectList('Ключевые финансовые условия по темам', {
    topic: str('Тема: аванс, срок оплаты, гарантийное удержание, неустойка ГП, неустойка контрагента, индексация…'),
    clause: str('Пункт договора или «отсутствует»'),
    as_is: str('Как в договоре — кратко, своими словами'),
    assessment: choice(TERM_ASSESSMENTS, 'Оценка для генподрядчика'),
    practice: str('Ориентир практики — как обычно бывает (оценка, не норма)'),
    proposed: str('Что предложить; пусто, если менять не нужно'),
  }),
  money_risks: objectList('Денежные риски для ГП с расчётом', {
    risk: str('Что может случиться'),
    calculation: str('Формула и сумма в цифрах договора, например «0,1% × 500 млн × 30 дн. = 15 млн тг»'),
    mitigation: str('Как снизить риск'),
  }),
});

const NEGOTIATION_SCHEMA = objectList('План переговоров: правки по приоритету', {
  priority: choice(NEGOTIATION_PRIORITIES, 'обязательно / желательно / можно уступить'),
  clause: str('Пункт договора или «новый пункт»'),
  ask: str('Что просить — конкретная редакция или условие'),
  fallback: str('Запасная позиция, если откажут'),
  argument: str('Аргумент для другой стороны'),
});

const COUNTERPARTY_SCHEMA = object('Проверка контрагента по открытым источникам', {
  name: str('Наименование контрагента как в договоре'),
  bin: str('БИН/ИИН контрагента из договора, 12 цифр; пусто, если нет'),
  verdict: choice(COUNTERPARTY_VERDICTS, 'Итог проверки'),
  facts: objectList('Найденные факты — каждый с источником', {
    fact: str('Факт о контрагенте'),
    source: str('Название источника'),
    url: str('Адрес страницы, где это найдено'),
  }),
  red_flags: strList('Красные флаги для генподрядчика'),
  not_verified: strList('Что не удалось проверить и почему'),
});

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
      financial: FINANCIAL_SCHEMA,
      negotiation: NEGOTIATION_SCHEMA,
      counterparty: COUNTERPARTY_SCHEMA,
    },
    required: ['contract', 'gc_role', 'applicable_acts', 'summary', 'findings', 'general_issues', 'not_checked', 'financial', 'negotiation', 'counterparty'],
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

export type FinancialVerdict = (typeof FINANCIAL_VERDICTS)[number];
export type TermAssessment = (typeof TERM_ASSESSMENTS)[number];
export type NegotiationPriority = (typeof NEGOTIATION_PRIORITIES)[number];
export type CounterpartyVerdict = (typeof COUNTERPARTY_VERDICTS)[number];

export interface FinancialTerm {
  topic: string;
  clause: string;
  as_is: string;
  assessment: TermAssessment;
  practice: string;
  proposed: string;
}

export interface MoneyRisk {
  risk: string;
  calculation: string;
  mitigation: string;
}

export interface FinancialAssessment {
  verdict: FinancialVerdict;
  verdict_reason: string;
  gc_pays: boolean | null;
  price: string;
  cash_flow: string;
  liability_balance: string;
  terms: FinancialTerm[];
  money_risks: MoneyRisk[];
}

export interface NegotiationItem {
  priority: NegotiationPriority;
  clause: string;
  ask: string;
  fallback: string;
  argument: string;
}

export interface CounterpartyFact {
  fact: string;
  source: string;
  url: string;
}

export interface SubmittedCounterparty {
  name: string;
  bin: string;
  verdict: CounterpartyVerdict;
  facts: CounterpartyFact[];
  red_flags: string[];
  not_verified: string[];
}

export interface SubmittedReview {
  contract: string;
  gc_role: string;
  applicable_acts: string;
  summary: string;
  findings: SubmittedFinding[];
  general_issues: string[];
  not_checked: string[];
  financial: FinancialAssessment | null;
  negotiation: NegotiationItem[];
  counterparty: SubmittedCounterparty | null;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
const records = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
function oneOf<T extends string>(values: readonly T[], v: unknown, fallback: T): T {
  return (values as readonly string[]).includes(v as string) ? (v as T) : fallback;
}

function parseFinancial(v: unknown): FinancialAssessment | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  const result: FinancialAssessment = {
    verdict: oneOf(FINANCIAL_VERDICTS, f.verdict, 'сбалансирован'),
    verdict_reason: text(f.verdict_reason),
    gc_pays: typeof f.gc_pays === 'boolean' ? f.gc_pays : null,
    price: text(f.price),
    cash_flow: text(f.cash_flow),
    liability_balance: text(f.liability_balance),
    terms: records(f.terms)
      .map((t) => ({
        topic: text(t.topic),
        clause: text(t.clause),
        as_is: text(t.as_is),
        assessment: oneOf(TERM_ASSESSMENTS, t.assessment, 'нейтрально'),
        practice: text(t.practice),
        proposed: text(t.proposed),
      }))
      .filter((t) => t.topic),
    money_risks: records(f.money_risks)
      .map((r) => ({ risk: text(r.risk), calculation: text(r.calculation), mitigation: text(r.mitigation) }))
      .filter((r) => r.risk),
  };
  // Модель вернула оболочку без содержания — раздела нет.
  return result.verdict_reason || result.terms.length || result.money_risks.length ? result : null;
}

function parseNegotiation(v: unknown): NegotiationItem[] {
  return records(v)
    .map((n) => ({
      priority: oneOf(NEGOTIATION_PRIORITIES, n.priority, 'желательно'),
      clause: text(n.clause),
      ask: text(n.ask),
      fallback: text(n.fallback),
      argument: text(n.argument),
    }))
    .filter((n) => n.ask);
}

function parseCounterparty(v: unknown): SubmittedCounterparty | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  return {
    name: text(c.name),
    bin: text(c.bin).replace(/\D/g, ''),
    verdict: oneOf(COUNTERPARTY_VERDICTS, c.verdict, 'не удалось проверить'),
    facts: records(c.facts)
      .map((f) => ({ fact: text(f.fact), source: text(f.source), url: text(f.url) }))
      .filter((f) => f.fact),
    red_flags: strings(c.red_flags),
    not_verified: strings(c.not_verified),
  };
}

export function parseSubmittedReview(input: unknown): SubmittedReview | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  if (!text(i.summary) || !Array.isArray(i.findings)) return null;
  const findings = records(i.findings)
    .map((f) => ({
      clause: text(f.clause),
      as_is: text(f.as_is),
      proposed: text(f.proposed),
      reasoning: text(f.reasoning),
      gc_impact: text(f.gc_impact),
      norm_id: text(f.norm_id),
      quote: text(f.quote),
      risk: oneOf(RISK_LEVELS, f.risk, 'средний'),
      type: oneOf(FINDING_TYPES, f.type, 'коммерческий риск'),
    }));
  return {
    contract: text(i.contract),
    gc_role: text(i.gc_role),
    applicable_acts: text(i.applicable_acts),
    summary: text(i.summary),
    findings,
    general_issues: strings(i.general_issues),
    not_checked: strings(i.not_checked),
    financial: parseFinancial(i.financial),
    negotiation: parseNegotiation(i.negotiation),
    counterparty: parseCounterparty(i.counterparty),
  };
}

// ---------- Контрагент: БИН и источники ----------

// Контрольная цифра БИН/ИИН РК: веса 1…11, остаток от 11; если 10 —
// веса 3…11,1,2; снова 10 — номер недействителен.
export function binChecksumValid(bin: string): boolean {
  if (!/^\d{12}$/.test(bin)) return false;
  const d = [...bin].map(Number);
  const sum = (weights: number[]) => weights.reduce((acc, w, i) => acc + w * d[i], 0) % 11;
  let check = sum([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  if (check === 10) check = sum([3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2]);
  return check !== 10 && check === d[11];
}

// БИН/ИИН из реквизитов: 12 цифр рядом с меткой (пробелы внутри номера
// допускаются — так бывает в PDF). Порядок — как в тексте, без повторов.
export function extractBins(contractText: string): string[] {
  const found: string[] = [];
  const re = /(?:БИН|ИИН|BIN|IIN)\s*(?:\/\s*(?:ИИН|БИН))?\s*[:№-]?\s*((?:\d\s?){12})(?!\d)/gi;
  for (const m of contractText.matchAll(re)) {
    const bin = m[1].replace(/\s/g, '');
    if (!found.includes(bin)) found.push(bin);
  }
  return found;
}

// Сравнение адресов источников: без схемы, www, якоря и завершающего «/».
export function normalizeUrl(url: string): string {
  return url
    .trim()
    .replace(/#.*$/, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// Адреса, которые модель реально видела: всё, что похоже на URL, в блоках
// результатов серверных инструментов (web_search / web_fetch и их
// фильтрация кодом). Факт со ссылкой мимо этого списка — выдуманный источник.
export function collectSeenUrls(content: readonly { type: string }[], into: Set<string>): void {
  for (const block of content) {
    if (!block.type.endsWith('_tool_result') || block.type === 'tool_result') continue;
    for (const m of JSON.stringify(block).matchAll(/https?:\/\/[^\s"'<>\\)\]]+/g)) into.add(normalizeUrl(m[0]));
  }
}

export interface VerifiedCounterpartyFact extends CounterpartyFact {
  verified: boolean;
}

export interface CounterpartyCheck extends Omit<SubmittedCounterparty, 'facts'> {
  facts: VerifiedCounterpartyFact[];
  // БИН найден в тексте договора и контрольная цифра сходится.
  binInContract: boolean;
  binChecksumOk: boolean;
}

export function verifyCounterparty(c: SubmittedCounterparty, contractBins: string[], seenUrls: Set<string>): CounterpartyCheck {
  const bin = c.bin || (contractBins.length === 1 ? contractBins[0] : '');
  return {
    ...c,
    bin,
    facts: c.facts.map((f) => ({ ...f, verified: !!f.url && seenUrls.has(normalizeUrl(f.url)) })),
    binInContract: !!bin && contractBins.includes(bin),
    binChecksumOk: binChecksumValid(bin),
  };
}

export function counterpartyProblemsReport(c: CounterpartyCheck | null): string | null {
  if (!c) return null;
  const bad = c.facts.filter((f) => !f.verified);
  if (bad.length === 0) return null;
  const lines = bad.map((f) => `- «${f.fact.slice(0, 100)}» — ${f.url || 'без адреса'}`);
  return `Сервер не нашёл эти адреса среди страниц, полученных через web_search / web_fetch (${bad.length} факт(ов) о контрагенте):\n${lines.join('\n')}\nУкажи точный адрес страницы из результатов поиска или убери факт (перенеси в not_verified), затем вызови submit_review заново со ВСЕМИ разделами.`;
}

// Ссылки для ручной проверки — от сервера, не от модели: адреса постоянные,
// а госсайты РК из-за рубежа бывают недоступны, и юрист проверит сам.
export function manualCheckLinks(bin: string): { title: string; url: string; what: string }[] {
  const by = bin ? ` (БИН ${bin})` : '';
  return [
    { title: 'КГД МФ РК — электронные сервисы', url: 'https://kgd.gov.kz', what: `налоговая задолженность, бездействующие, банкротство и ликвидация${by}` },
    { title: 'Бюро национальной статистики', url: 'https://stat.gov.kz', what: `регистрация, вид деятельности, размер предприятия${by}` },
    { title: 'Портал госзакупок', url: 'https://goszakup.gov.kz', what: 'реестр недобросовестных участников госзакупок' },
    { title: 'Реестр должников (АИС ОИП)', url: 'https://aisoip.adilet.gov.kz', what: 'исполнительные производства и запрет на выезд руководителя' },
    { title: 'Судебный кабинет', url: 'https://office.sud.kz', what: 'судебные дела с участием контрагента' },
    { title: 'Е-лицензирование', url: 'https://elicense.kz', what: 'строительная лицензия и её категория' },
    { title: 'Депозитарий финансовой отчётности', url: 'https://dfo.kz', what: 'финансовая отчётность (для организаций, обязанных её публиковать)' },
  ];
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
  // Разделы ноября 2026; в разборах, сделанных раньше, их нет.
  financial?: FinancialAssessment | null;
  negotiation?: NegotiationItem[];
  counterparty?: CounterpartyCheck | null;
  model: string;
}

const PRIORITY_ORDER: Record<NegotiationPriority, number> = { обязательно: 0, желательно: 1, 'можно уступить': 2 };

export function sortNegotiation(items: NegotiationItem[]): NegotiationItem[] {
  return items
    .map((n, i) => ({ n, i }))
    .sort((a, b) => PRIORITY_ORDER[a.n.priority] - PRIORITY_ORDER[b.n.priority] || a.i - b.i)
    .map(({ n }) => n);
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
  if (review.financial) out.push(`**Финансово для ГП: ${review.financial.verdict}.** ${review.financial.verdict_reason}`);
  if (top.length) out.push(`**Главное:**\n${top.join('\n')}`);
  const must = sortNegotiation(review.negotiation ?? []).filter((n) => n.priority === 'обязательно');
  if (must.length) {
    const asks = must.slice(0, 5).map((n, i) => `${i + 1}. ${n.clause ? `**${n.clause}**: ` : ''}${n.ask}`);
    out.push(`**Добиваться обязательно:**\n${asks.join('\n')}`);
  }
  const cp = review.counterparty;
  if (cp) {
    const head = `**Контрагент${cp.name ? ` ${cp.name}` : ''}: ${cp.verdict}.**`;
    const flags = cp.red_flags.length ? ` Красные флаги: ${cp.red_flags.slice(0, 3).join('; ')}.` : '';
    const bin = cp.bin && !cp.binChecksumOk ? ` БИН ${cp.bin} не проходит проверку контрольной цифры — сверьте реквизиты.` : '';
    out.push(`${head}${flags}${bin}`);
  }
  if (unverified) out.push(`**Не подтверждено проверкой по базе: ${unverified}** — отмечены в отчёте.`);
  out.push(`Полный отчёт с правками, финансовой оценкой, планом переговоров и проверкой контрагента — в файле ниже. _${DISCLAIMER}_`);
  return out.join('\n\n');
}

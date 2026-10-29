import type {
  SkillEffort,
  SkillKind,
  SkillModel,
  SkillOutput,
} from '@prisma/client';

// ARMS, фаза 3 — навыки. Здесь только чистые вещи (тестируются без БД и
// ключа): модели, разбор «/slug», system-блоки навыка и тона, стартовые
// навыки.

// Маппинг на id моделей — в одном месте (claude-api, 25.10.2026). У всех
// трёх thinking включён по умолчанию; принудительный tool_choice на Sonnet/
// Opus 5.5 даёт 400 — в чате он и не нужен (auto).
export const SKILL_MODEL_IDS: Record<SkillModel, string> = {
  HAIKU: 'claude-haiku-5-5',
  SONNET: 'claude-sonnet-5-5',
  OPUS: 'claude-opus-5-5',
};

export const SKILL_EFFORT_VALUES: Record<
  SkillEffort,
  'low' | 'medium' | 'high'
> = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

// Размышления входят в max_tokens: большим моделям — с запасом.
export const SKILL_MAX_TOKENS: Record<SkillModel, number> = {
  HAIKU: 8192,
  SONNET: 16000,
  OPUS: 16000,
};

// Навыку можно больше раундов инструментов, чем обычному чату: подготовка к
// встрече — календарь, задачи, прошлые встречи, письма.
export const SKILL_MAX_TOOL_ROUNDS = 6;

export const SKILL_INSTRUCTIONS_MAX = 16000;
export const SKILL_SLUG_MAX = 32;
// Строчные буквы (в т.ч. кириллица) и цифры, слова через дефис: «к-встрече».
export const SKILL_SLUG_RE = /^[\p{Ll}\p{N}]+(?:-[\p{Ll}\p{N}]+)*$/u;

export const TONE_SLUG = 'тон';
export const TONE_PLACEHOLDER =
  'Пока пусто. Соберите стиль из отправленных писем на странице навыка.';

// Навык вызывает только человек — «/slug» в начале сообщения. Модель сама
// навык не выбирает (план ARMS: поведение должно быть предсказуемым).
export function parseSkillInvocation(
  text: string,
): { slug: string; rest: string } | null {
  const m = /^\/([\p{L}\p{N}-]{1,32})(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!m) return null;
  return { slug: m[1].toLowerCase(), rest: (m[2] ?? '').trim() };
}

// Что уходит модели вместо «/slug …»: сам вызов уже описан блоком [skill].
export function skillUserText(rest: string): string {
  return rest || 'Выполни навык.';
}

export function buildSkillBlock(skill: {
  slug: string;
  title: string;
  instructions: string;
}): string {
  return `[skill /${skill.slug} — ${skill.title}]
Пользователь вызвал этот навык. Выполни его по инструкции ниже. Инструкция
уточняет порядок работы и формат ответа, но не отменяет общие правила и
права доступа. Инструментов сейчас ровно столько, сколько разрешено навыку.

${skill.instructions.trim()}
[/skill]`;
}

// Тон писем руководителя (навык /тон) — рядом с памятью: модель пишет текст
// писем сама (draft_mail_reply.body), поэтому стиль нужен ей в каждом ответе.
export function buildToneBlock(instructions: string): string | null {
  const text = instructions.trim();
  if (!text || text === TONE_PLACEHOLDER) return null;
  return `[tone]
Стиль писем руководителя. Применяй его в body для draft_mail_reply и в любых
текстах писем от его имени. Примеры — ориентир по манере, не шаблон: не
копируй из них фразы дословно.

${text}
[/tone]`;
}

// Подписи инструментов для страницы навыка (порядок — как в списке).
export const SKILL_TOOL_LABELS: Record<string, string> = {
  get_tasks: 'Задачи',
  find_tasks: 'Поиск задач',
  get_task: 'Задача целиком',
  export_tasks_xlsx: 'Выгрузка задач в Excel',
  get_events: 'Календарь',
  find_events: 'Поиск событий',
  find_free_slots: 'Свободное время',
  get_recent_meetings: 'Последние встречи',
  search_meetings: 'Поиск встреч',
  get_meeting: 'Саммари встречи',
  search_meeting_transcript: 'Поиск по расшифровке',
  create_task_from_meeting: 'Задача из встречи',
  find_employee_by_competency: 'Сотрудник по компетенции',
  search_emails: 'Поиск писем',
  get_email: 'Письмо целиком',
  propose_mail_actions: 'Действия с письмами',
  draft_mail_reply: 'Черновик письма',
  legal_ask: 'Вопрос юристу',
  legal_review_contract: 'Разбор договора',
  legal_review_status: 'Статус разбора',
  remember: 'Запомнить',
  recall_memory: 'Найти в памяти',
  forget_memory: 'Забыть',
};

export interface SkillSeed {
  slug: string;
  title: string;
  description: string;
  kind: SkillKind;
  model: SkillModel;
  effort: SkillEffort;
  output: SkillOutput;
  allowedTools: string[];
  instructions: string;
}

// Стартовые общие навыки. Создаются при старте, если их нет; дальше их
// правят люди — seed существующие не трогает.
export const SYSTEM_SKILLS: SkillSeed[] = [
  {
    slug: 'день',
    title: 'Мой день',
    description: 'Что сегодня: встречи, просрочки, письма, ждущие ответа.',
    kind: 'ACTION',
    model: 'HAIKU',
    effort: 'LOW',
    output: 'TELEGRAM',
    allowedTools: ['get_events', 'find_tasks', 'search_emails'],
    instructions: `Собери короткую сводку на сегодня.

1. Встречи: get_events. Оставь только сегодняшние (дата — из контекста), по
   времени: «10:00 — название, место».
2. Задачи: find_tasks с overdue=true. Сколько просрочено всего (overdueCount)
   и у кого больше всего (byAssignee, до 3 человек); 3–5 самых давних:
   название, исполнитель, на сколько дней просрочено (daysOverdue). Затем
   find_tasks со сроком на сегодня (dueFrom/dueTo — весь сегодняшний день):
   что должно закрыться сегодня.
3. Письма: search_emails с needsReply=true и readStatus="all" за последние
   3 дня. До 5 самых важных: от кого, тема, что нужно ответить.

Формат: три коротких блока с заголовками «Встречи», «Задачи», «Письма».
Пустой блок — одной строкой («Встреч сегодня нет»). Без вступлений и
выводов. Это сообщение читают в Telegram — держи его в пределах экрана.`,
  },
  {
    slug: 'к-встрече',
    title: 'Подготовка к встрече',
    description:
      'Ближайшая встреча: кто будет, их задачи, прошлые встречи, открытые письма.',
    kind: 'PLAYBOOK',
    model: 'OPUS',
    effort: 'MEDIUM',
    output: 'CHAT',
    allowedTools: [
      'get_events',
      'find_tasks',
      'get_recent_meetings',
      'search_meetings',
      'get_meeting',
      'search_emails',
      'get_email',
    ],
    instructions: `Подготовь руководителя к встрече.

1. Встреча: если пользователь назвал её — найди в get_events по названию или
   участникам; иначе возьми ближайшую по времени.
2. Участники: для каждого — find_tasks с assigneeRawText = его полное имя:
   открытые задачи и сколько из них просрочено (overdueCount).
3. История: search_meetings по фамилиям участников и теме; по 1–2 самым
   свежим — get_meeting, что решили и что обещали.
4. Почта: search_emails по участникам за последние 2 недели, особенно
   needsReply=true.

Ответ: «Встреча» (когда, где, с кем) → «Что было в прошлый раз» → «Открытые
вопросы и задачи по участникам» → «О чём спросить» (3–5 пунктов). Только
факты из инструментов; чего не нашёл — так и скажи.`,
  },
  {
    slug: 'просрочки',
    title: 'Разбор просрочек',
    description:
      'Просроченные задачи по исполнителям и короткие сообщения каждому.',
    kind: 'PLAYBOOK',
    model: 'HAIKU',
    effort: 'LOW',
    output: 'CHAT',
    allowedTools: ['find_tasks'],
    instructions: `Разбери просроченные задачи.

1. find_tasks с overdue=true и limit=30.
2. Сгруппируй по исполнителям (byAssignee), сначала тех, у кого больше
   просрочек. Если просроченных больше, чем показано (overdueCount больше
   числа задач), скажи об этом и разбери показанные.
3. Для каждого: список задач (название, daysOverdue — на сколько дней) и
   короткое сообщение исполнителю от лица руководителя — вежливо, по делу,
   с просьбой назвать новый срок. Одно сообщение на человека.

Если просрочек нет — одной фразой.`,
  },
  {
    slug: 'итоги-недели',
    title: 'Итоги недели',
    description: 'Отчёт за неделю в Word: задачи, встречи, решения, письма.',
    kind: 'ACTION',
    model: 'SONNET',
    effort: 'MEDIUM',
    output: 'DOCX',
    allowedTools: [
      'find_tasks',
      'get_recent_meetings',
      'get_meeting',
      'search_emails',
    ],
    instructions: `Подготовь отчёт руководителя за последние 7 дней. Текст ответа целиком
станет документом Word, поэтому пиши его как документ.

Данные:
1. find_tasks без фильтров (все открытые: totalCount, byAssignee), find_tasks
   с overdue=true и find_tasks со status ["DONE"] и dueFrom = 7 дней назад
   (выполненные со сроком на этой неделе).
2. get_recent_meetings (limit 10), для встреч этой недели — get_meeting.
3. search_emails за 7 дней с importance CRITICAL и IMPORTANT.

Структура (markdown): «# Итоги недели» и период; «## Главное» — 3–5
пунктов; «## Задачи» — сколько всего, что закрыто, что просрочено и у кого;
«## Встречи и решения» — по встрече: дата, тема, решения, поручения;
«## Почта» — важные письма и что по ним нужно; «## На следующую неделю».
Только факты из инструментов, без выдуманных цифр.`,
  },
  {
    slug: TONE_SLUG,
    title: 'Тон писем',
    description: 'Стиль писем руководителя — учитывается в черновиках писем.',
    kind: 'KNOWLEDGE',
    model: 'HAIKU',
    effort: 'LOW',
    output: 'CHAT',
    allowedTools: ['search_emails', 'get_email', 'draft_mail_reply'],
    instructions: TONE_PLACEHOLDER,
  },
];

// Прежние тексты системных навыков (до единого агента A1, 28.10.2026): при
// старте общий навык обновляется до нового seed, только если его инструкция
// и инструменты совпадают с прежними дословно — правки людей не трогаем.
export interface SkillSeedUpgrade {
  slug: string;
  allowedTools: string[];
  instructions: string;
}

export const SYSTEM_SKILL_UPGRADES: SkillSeedUpgrade[] = [
  {
    slug: 'день',
    allowedTools: ['get_events', 'get_tasks', 'search_emails'],
    instructions: `Собери короткую сводку на сегодня.

1. Встречи: get_events. Оставь только сегодняшние (дата — из контекста), по
   времени: «10:00 — название, место».
2. Задачи: get_tasks с filter="overdue". Сколько просрочено и 3–5 самых
   давних: название, исполнитель, на сколько дней просрочено.
3. Письма: search_emails с needsReply=true и readStatus="all" за последние
   3 дня. До 5 самых важных: от кого, тема, что нужно ответить.

Формат: три коротких блока с заголовками «Встречи», «Просрочки», «Письма».
Пустой блок — одной строкой («Встреч сегодня нет»). Без вступлений и
выводов. Это сообщение читают в Telegram — держи его в пределах экрана.`,
  },
  {
    slug: 'к-встрече',
    allowedTools: [
      'get_events',
      'get_tasks',
      'get_recent_meetings',
      'search_meetings',
      'get_meeting',
      'search_emails',
      'get_email',
    ],
    instructions: `Подготовь руководителя к встрече.

1. Встреча: если пользователь назвал её — найди в get_events по названию или
   участникам; иначе возьми ближайшую по времени.
2. Участники: для каждого — открытые и просроченные задачи из get_tasks
   (filter="all"), где он исполнитель.
3. История: search_meetings по фамилиям участников и теме; по 1–2 самым
   свежим — get_meeting, что решили и что обещали.
4. Почта: search_emails по участникам за последние 2 недели, особенно
   needsReply=true.

Ответ: «Встреча» (когда, где, с кем) → «Что было в прошлый раз» → «Открытые
вопросы и задачи по участникам» → «О чём спросить» (3–5 пунктов). Только
факты из инструментов; чего не нашёл — так и скажи.`,
  },
  {
    slug: 'просрочки',
    allowedTools: ['get_tasks'],
    instructions: `Разбери просроченные задачи.

1. get_tasks с filter="overdue".
2. Сгруппируй по исполнителям, сначала тех, у кого больше просрочек.
3. Для каждого: список задач (название, на сколько дней просрочено) и
   короткое сообщение исполнителю от лица руководителя — вежливо, по делу,
   с просьбой назвать новый срок. Одно сообщение на человека.

Если просрочек нет — одной фразой.`,
  },
  {
    slug: 'итоги-недели',
    allowedTools: [
      'get_tasks',
      'get_recent_meetings',
      'get_meeting',
      'search_emails',
    ],
    instructions: `Подготовь отчёт руководителя за последние 7 дней. Текст ответа целиком
станет документом Word, поэтому пиши его как документ.

Данные:
1. get_tasks (filter="all") и get_tasks (filter="overdue").
2. get_recent_meetings (limit 10), для встреч этой недели — get_meeting.
3. search_emails за 7 дней с importance CRITICAL и IMPORTANT.

Структура (markdown): «# Итоги недели» и период; «## Главное» — 3–5
пунктов; «## Задачи» — сколько всего, что закрыто, что просрочено и у кого;
«## Встречи и решения» — по встрече: дата, тема, решения, поручения;
«## Почта» — важные письма и что по ним нужно; «## На следующую неделю».
Только факты из инструментов, без выдуманных цифр.`,
  },
];

// Какие существующие общие навыки обновить до текущего seed: только те, чей
// текст и набор инструментов дословно совпадают с прежним seed.
export function pickSkillUpgrades(
  existing: {
    id: string;
    slug: string;
    instructions?: string | null;
    allowedTools?: string[] | null;
  }[],
  upgrades: SkillSeedUpgrade[] = SYSTEM_SKILL_UPGRADES,
  seeds: SkillSeed[] = SYSTEM_SKILLS,
): { id: string; seed: SkillSeed }[] {
  const sameTools = (a: string[], b: string[]) =>
    a.length === b.length && a.every((t, i) => t === b[i]);
  return existing.flatMap((skill) => {
    const from = upgrades.find((u) => u.slug === skill.slug);
    const seed = seeds.find((s) => s.slug === skill.slug);
    if (
      !from ||
      !seed ||
      skill.instructions !== from.instructions ||
      !sameTools(skill.allowedTools ?? [], from.allowedTools)
    )
      return [];
    return [{ id: skill.id, seed }];
  });
}

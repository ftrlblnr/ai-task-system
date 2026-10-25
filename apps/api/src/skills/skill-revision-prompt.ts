import { SKILL_INSTRUCTIONS_MAX } from './skill-catalog';

// ARMS, фаза 3 — самоулучшение навыков (кадр 06): модель предлагает новую
// инструкцию, человек смотрит дифф и решает. Здесь — чистые билдеры
// промптов и разбор ответа.

export const REVISION_SCHEMA = {
  type: 'object',
  properties: {
    instructions: { type: 'string', description: 'Новая инструкция навыка целиком, markdown' },
    reason: { type: 'string', description: 'Что изменено и почему — 1–3 предложения' },
  },
  required: ['instructions', 'reason'],
  additionalProperties: false,
} as const;

export interface FeedbackSample {
  value: 'UP' | 'DOWN';
  text: string | null;
  input: string;
  answer: string;
}

const ANSWER_EXCERPT = 1500;
const EMAIL_EXCERPT = 1500;
const PROMPT_BUDGET = 60000;

export const FEEDBACK_SYSTEM = `Ты улучшаешь инструкцию навыка корпоративного ассистента «Адъютант»
(руководитель строительной компании, Казахстан). Навык — инструкция,
по которой модель отвечает, когда руководитель пишет «/команда».

Тебе дают текущую инструкцию и отзывы руководителя на ответы навыка: 👍 —
что было хорошо, 👎 с комментарием — что не так. Перепиши инструкцию так,
чтобы следующие ответы учитывали замечания, и сохрани то, что хвалили.

Правила:
- Меняй только то, на что есть основания в отзывах. Не придумывай новых
  требований и не расширяй навык на другие задачи.
- Сохрани язык, структуру и названия инструментов из текущей инструкции.
- Пиши коротко и конкретно: шаги, формат ответа, чего избегать.
- reason — для руководителя: что поменял и на какие отзывы опирался.`;

export const TONE_SYSTEM = `Ты составляешь описание стиля деловых писем руководителя по его
отправленным письмам. Описание будет подсказкой для ассистента, который
пишет черновики писем от имени руководителя.

Структура (markdown):
## Правила
8–15 коротких пунктов: обращение и приветствие, длина, структура, как
формулирует просьбы и сроки, как отказывает, завершение и подпись, на «вы»
или «ты», язык (русский/казахский), чего никогда не пишет.
## Примеры
10–20 коротких типичных фраз или фрагментов из писем (1–2 предложения),
обезличенных: без телефонов, сумм, номеров договоров и персональных данных.

Опирайся только на письма. reason — одной фразой: по скольким письмам
и что главное в стиле.`;

export function buildFeedbackUserContent(skill: { slug: string; title: string; instructions: string }, samples: FeedbackSample[]): string {
  const head = `Навык /${skill.slug} — ${skill.title}

Текущая инструкция:
<instructions>
${skill.instructions}
</instructions>

Отзывы (новые сверху):`;
  const parts: string[] = [];
  let used = head.length;
  for (const s of samples) {
    const block = `
---
Оценка: ${s.value === 'UP' ? '👍' : '👎'}${s.text ? `\nКомментарий: ${s.text}` : ''}
Запрос: ${s.input || '(без уточнений)'}
Ответ навыка: ${s.answer.slice(0, ANSWER_EXCERPT)}`;
    if (used + block.length > PROMPT_BUDGET) break;
    parts.push(block);
    used += block.length;
  }
  return head + parts.join('');
}

// Цитата исходного письма и всё ниже неё — не стиль руководителя.
export function stripQuoted(body: string): string {
  const lines = body.replace(/\r/g, '').split('\n');
  const cut = lines.findIndex(
    (l) =>
      /^\s*>/.test(l) ||
      /^-{2,}\s*(Original Message|Исходное сообщение|Пересылаемое сообщение|Forwarded message)/i.test(l.trim()) ||
      /^(From|От|Sent|Отправлено):\s/i.test(l.trim()) ||
      /(пишет|wrote):\s*$/i.test(l.trim()),
  );
  return (cut >= 0 ? lines.slice(0, cut) : lines).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildToneUserContent(emails: { subject: string | null; body: string }[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const e of emails) {
    const body = stripQuoted(e.body).slice(0, EMAIL_EXCERPT);
    if (body.length < 20) continue;
    const block = `---\nТема: ${e.subject ?? '(без темы)'}\n${body}\n`;
    if (used + block.length > PROMPT_BUDGET) break;
    parts.push(block);
    used += block.length;
  }
  return `Отправленные письма руководителя (${parts.length}):\n\n${parts.join('\n')}`;
}

export function countToneEmails(emails: { body: string }[]): number {
  return emails.filter((e) => stripQuoted(e.body).length >= 20).length;
}

export class RevisionParseError extends Error {}

export function parseRevision(text: string): { instructions: string; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RevisionParseError('ответ модели — не JSON');
  }
  const d = data as { instructions?: unknown; reason?: unknown };
  if (typeof d.instructions !== 'string' || d.instructions.trim().length < 20) throw new RevisionParseError('пустая инструкция');
  return {
    instructions: d.instructions.trim().slice(0, SKILL_INSTRUCTIONS_MAX),
    reason: typeof d.reason === 'string' ? d.reason.trim().slice(0, 1000) : '',
  };
}

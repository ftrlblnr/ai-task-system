import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { formatLocalDateTime } from '../common/timezone';

// Release 2 — чистый билдер промпта/схемы тула для AI-анализа одного письма,
// тот же приём, что в meetings/meeting-task-extraction.service.ts: логика
// промпта тестируется без живого API-ключа, инжектируемый сервис (см.
// mail-analysis.service.ts) занимается только вызовом Anthropic и записью в БД.

export interface EmailAnalysisAttachmentInput {
  fileName: string;
  extractedText: string | null;
}

export interface EmailAnalysisInput {
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  to: string[];
  cc: string[];
  textBody: string | null;
  attachments: EmailAnalysisAttachmentInput[];
}

export interface EmailAnalysisDraft {
  summary: string;
  importance: 'CRITICAL' | 'IMPORTANT' | 'NORMAL' | 'LOW';
  category:
    | 'ACTION_REQUIRED'
    | 'DECISION_REQUIRED'
    | 'INFORMATION'
    | 'DOCUMENT'
    | 'COMMERCIAL'
    | 'LEGAL'
    | 'FINANCE'
    | 'PROJECT'
    | 'MEETING'
    | 'NEWSLETTER'
    | 'OTHER';
  needsReply: boolean;
  needsAction: boolean;
  actionSummary: string | null;
  deadline: string | null;
}

// Nullable через anyOf, не через type-массив — та же конвенция, что в
// draft-extraction.service.ts/meeting-task-extraction.service.ts.
const NULLABLE_STRING = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

export const MAX_ANALYSIS_BODY_CHARS = 8000;
export const MAX_ANALYSIS_ATTACHMENT_CHARS = 4000;

export function buildAnalysisTool(): Anthropic.Tool {
  return {
    name: 'analyze_email',
    description: 'Классифицировать письмо: важность, категория, нужен ли ответ/действие, срок.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Одно-два предложения по-русски — суть письма.' },
        importance: { type: 'string', enum: ['CRITICAL', 'IMPORTANT', 'NORMAL', 'LOW'] },
        category: {
          type: 'string',
          enum: [
            'ACTION_REQUIRED',
            'DECISION_REQUIRED',
            'INFORMATION',
            'DOCUMENT',
            'COMMERCIAL',
            'LEGAL',
            'FINANCE',
            'PROJECT',
            'MEETING',
            'NEWSLETTER',
            'OTHER',
          ],
        },
        needsReply: { type: 'boolean' },
        needsAction: { type: 'boolean' },
        actionSummary: NULLABLE_STRING,
        deadline: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
      },
      required: ['summary', 'importance', 'category', 'needsReply', 'needsAction', 'actionSummary', 'deadline'],
      additionalProperties: false,
    },
  };
}

export function buildAnalysisSystemPrompt(): string {
  return `Ты анализируешь входящее письмо руководителя. Вызови инструмент analyze_email ровно один раз.

importance — CRITICAL (требует внимания сегодня), IMPORTANT (важно, но не горит),
NORMAL (обычная переписка), LOW (справочно/не по делу лично руководителю).
Если руководитель только в копии (CC), а не в получателях (To), и в письме нет
прямого действия или срока именно для него — не завышай importance выше NORMAL.

needsReply — нужен ли ответ ИМЕННО от руководителя (не рассылка, не автоответ,
не письмо, адресованное другим). needsAction — нужно ли какое-то действие
(не обязательно ответ письмом — например, подписать документ, оплатить счёт).

deadline — если в письме назван срок, разрешай относительные даты ("до пятницы",
"в течение недели") ОТНОСИТЕЛЬНО ДАТЫ ПИСЬМА, не текущего момента. Если срока
нет — null, не придумывай.

summary — 1-2 предложения на русском, о чём письмо и что от руководителя требуется
(если требуется).`;
}

function truncate(text: string | null, max: number): string | null {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildAnalysisUserContent(input: EmailAnalysisInput): string {
  const date = input.receivedAt ?? input.sentAt;
  const lines = [
    `От: ${input.fromName ? `${input.fromName} <${input.fromAddress}>` : input.fromAddress}`,
    `Кому: ${input.to.join(', ') || '(не указано)'}`,
    input.cc.length > 0 ? `Копия: ${input.cc.join(', ')}` : null,
    `Дата: ${date ? formatLocalDateTime(date) : '(неизвестна)'}`,
    `Тема: ${input.subject ?? '(без темы)'}`,
    '',
    truncate(input.textBody, MAX_ANALYSIS_BODY_CHARS) ?? '(пустое тело письма)',
  ];
  for (const a of input.attachments) {
    if (!a.extractedText) continue;
    lines.push('', `Вложение «${a.fileName}»:`, truncate(a.extractedText, MAX_ANALYSIS_ATTACHMENT_CHARS) as string);
  }
  return lines.filter((l) => l !== null).join('\n');
}

// Хэш входа — не используется для повторного анализа в этом релизе (письмо
// анализируется один раз при первом появлении, содержимое писем не меняется
// задним числом), но поле заполняется сразу для будущего ручного реанализа.
export function computeAnalysisInputHash(input: EmailAnalysisInput): string {
  const raw = buildAnalysisUserContent(input);
  return createHash('sha256').update(raw).digest('hex');
}

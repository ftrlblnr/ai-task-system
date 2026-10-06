import type Anthropic from '@anthropic-ai/sdk';
import { formatLocalDateTime } from '../../common/timezone';
import type { MessageForActionAnalysis } from '../mail-store';
import type { MailActionCandidate } from './mail-action-plan.service';

// Почтовый ИИ-агент v2.0 (05.10.2026), раздел 5/6 ТЗ — чистый билдер
// промпта/схемы тула для анализа ОДНОГО плана (не письма, как
// mail-analysis.ts — там классификация, здесь предложение действий по
// намерению владельца). Тот же приём: логика промпта тестируется без
// живого API-ключа, инжектируемый сервис занимается только вызовом
// Anthropic и записью пунктов плана.

// Раздел 3 ТЗ, Этап 1 — только эти типы предлагает анализ сейчас.
// CREATE_FOLDER намеренно не предлагается моделью (раздел 8 ТЗ: это
// создавало бы зависимость MOVE→CREATE_FOLDER, которую модель должна была
// бы сама выстроить корректно) — MOVE в этой версии анализа возможен
// только в УЖЕ существующую папку из переданного списка.
export const STAGE1_ANALYSIS_ACTION_TYPES = ['ARCHIVE', 'TRASH', 'MOVE', 'SET_READ', 'SET_UNREAD', 'FLAG', 'UNFLAG'] as const;
export type Stage1AnalysisActionType = (typeof STAGE1_ANALYSIS_ACTION_TYPES)[number];

export interface MailActionProposal {
  messageIndex: number;
  type: Stage1AnalysisActionType;
  folderPath: string | null;
  reason: string;
  relevance: 'RECOMMENDED' | 'KEEP' | 'NEEDS_REVIEW' | 'UNVERIFIED';
}

export const MAX_ANALYSIS_MESSAGES = 50;
const MAX_BODY_CHARS = 600;

export function buildMailActionTool(): Anthropic.Tool {
  return {
    name: 'propose_mail_actions',
    description: 'Предложить действия над перечисленными письмами согласно запросу владельца ящика.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              messageIndex: { type: 'integer', description: 'Номер письма из списка (с единицы).' },
              type: { type: 'string', enum: STAGE1_ANALYSIS_ACTION_TYPES as unknown as string[] },
              folderPath: {
                anyOf: [{ type: 'string' }, { type: 'null' }],
                description: 'Только для MOVE — путь СУЩЕСТВУЮЩЕЙ папки из списка «Папки ящика». Для остальных типов — null.',
              },
              reason: { type: 'string', description: 'Одно предложение по-русски — почему это действие подходит именно этому письму.' },
              relevance: { type: 'string', enum: ['RECOMMENDED', 'KEEP', 'NEEDS_REVIEW', 'UNVERIFIED'] },
            },
            required: ['messageIndex', 'type', 'folderPath', 'reason', 'relevance'],
            additionalProperties: false,
          },
        },
      },
      required: ['actions'],
      additionalProperties: false,
    },
  };
}

export function buildMailActionSystemPrompt(): string {
  return `Ты помогаешь владельцу почтового ящика привести его в порядок по его запросу.
Вызови инструмент propose_mail_actions ровно один раз со списком предложенных действий.

Правила:
- Предлагай действие ТОЛЬКО для писем, которые явно подходят под запрос владельца. Письмо,
  которое не подходит, просто не включай в actions — не придумывай для него действие.
- ARCHIVE/TRASH — переместить в архив/корзину. Папку не указывай (folderPath: null), она
  определяется автоматически.
- MOVE — folderPath ОБЯЗАТЕЛЬНО один из уже существующих путей из списка «Папки ящика» ниже.
  Никогда не изобретай новое имя папки — если подходящей папки нет, не предлагай MOVE для
  этого письма вообще.
- SET_READ/SET_UNREAD/FLAG/UNFLAG — folderPath: null.
- relevance: RECOMMENDED — уверен, что действие нужно; KEEP — письмо явно НЕ нужно трогать
  (используй редко, только если запрос прямо просит отличить "оставить" от "убрать");
  NEEDS_REVIEW — действие подходит, но есть неоднозначность, пусть владелец посмотрит сам;
  UNVERIFIED — предполагаешь по косвенным признакам, не уверен.
- reason — коротко и конкретно, не общими словами.`;
}

function truncate(text: string | null, max: number): string | null {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildMailActionUserContent(requestText: string, messages: MessageForActionAnalysis[], folders: { path: string }[]): string {
  const lines: (string | null)[] = [
    `Запрос владельца: ${requestText}`,
    '',
    `Папки ящика: ${folders.map((f) => f.path).join(', ') || '(нет синкнутых папок)'}`,
    '',
    'Письма:',
  ];
  messages.forEach((m, i) => {
    lines.push(
      '',
      `${i + 1}. От: ${m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}`,
      `   Папка: ${m.folder.path} | Дата: ${m.receivedAt ? formatLocalDateTime(m.receivedAt) : '(неизвестна)'} | Прочитано: ${m.isRead ? 'да' : 'нет'}${m.hasAttachments ? ' | Есть вложения' : ''}`,
      `   Тема: ${m.subject ?? '(без темы)'}`,
      m.analysis?.importance && m.analysis.category ? `   Анализ: ${m.analysis.importance}/${m.analysis.category}` : null,
      `   ${truncate(m.textBody, MAX_BODY_CHARS) ?? '(пустое тело)'}`,
    );
  });
  return lines.filter((l) => l !== null).join('\n');
}

// Выход тула → пункты плана. Чистая функция (без DI) — отделена от
// mail-action-analysis.service.ts специально, чтобы тестировать правила
// без живого Anthropic-клиента (тот же приём, что mail-analysis.ts).
export function convertMailActionProposals(
  actions: MailActionProposal[],
  messages: MessageForActionAnalysis[],
  knownFolderPaths: ReadonlySet<string>,
): MailActionCandidate[] {
  const candidates: MailActionCandidate[] = [];
  for (const [i, action] of actions.entries()) {
    const message = messages[action.messageIndex - 1];
    if (!message) continue; // некорректный индекс от модели — пропускаем, не роняем весь анализ
    if (message.folder.uidValidity === null) continue; // защитно: вызывающий код уже должен был отфильтровать
    if (action.type === 'MOVE' && (!action.folderPath || !knownFolderPaths.has(action.folderPath))) continue; // раздел 9 ТЗ: только в существующую папку

    candidates.push({
      localId: `a${i}`,
      type: action.type,
      stableObjectIds: [message.id],
      sourceLocators: { folderPath: message.folder.path, uidValidity: message.folder.uidValidity, uid: message.uid },
      reason: action.reason,
      relevance: action.relevance,
      parameters: action.type === 'MOVE' ? { folderPath: action.folderPath } : {},
    });
  }
  return candidates;
}

import type { MailActionCandidate } from '../mail/action/mail-action-plan.service';
import { STAGE1_ANALYSIS_ACTION_TYPES, type Stage1AnalysisActionType } from '../mail/action/mail-action-analysis';

// Почта, этап 3 (владелец 23.10.2026) — ассистент в чате предлагает действия с
// письмами. Чистая часть: проверка того, что прислала модель, и раскладка
// по ящикам в пункты плана. Модель — не граница безопасности: id писем и
// папки сверяются с тем, что реально лежит в ящиках пользователя.

export const MAIL_TOOL_ACTION_TYPES = STAGE1_ANALYSIS_ACTION_TYPES;
export const MAX_MAIL_TOOL_ACTIONS = 50;

export interface MailToolActionInput {
  emailId: string;
  type: Stage1AnalysisActionType;
  folderPath: string | null;
  reason: string;
}

export interface MailToolMessage {
  id: string;
  mailboxId: string;
  uid: number;
  folder: { path: string; uidValidity: string | null };
}

export interface MailToolFolder {
  path: string;
  role: string;
}

export interface MailPlanDraft {
  byMailbox: Map<string, MailActionCandidate[]>;
  // Письма не найдены в ящиках пользователя или ещё не синхронизированы.
  unknownEmailIds: string[];
  // MOVE в папку, которой нет в ящике.
  missingFolders: string[];
}

export function parseMailToolActions(raw: unknown): MailToolActionInput[] {
  if (!Array.isArray(raw)) return [];
  const out: MailToolActionInput[] = [];
  for (const item of raw.slice(0, MAX_MAIL_TOOL_ACTIONS)) {
    const v = item as Partial<Record<keyof MailToolActionInput, unknown>> | null;
    if (!v || typeof v.emailId !== 'string' || !v.emailId) continue;
    if (typeof v.type !== 'string' || !(MAIL_TOOL_ACTION_TYPES as readonly string[]).includes(v.type)) continue;
    out.push({
      emailId: v.emailId,
      type: v.type as Stage1AnalysisActionType,
      folderPath: typeof v.folderPath === 'string' && v.folderPath.trim() ? v.folderPath.trim() : null,
      reason: typeof v.reason === 'string' ? v.reason.slice(0, 500) : '',
    });
  }
  return out;
}

export function buildMailPlanCandidates(actions: MailToolActionInput[], messages: MailToolMessage[], foldersByMailbox: Map<string, MailToolFolder[]>): MailPlanDraft {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const byMailbox = new Map<string, MailActionCandidate[]>();
  const unknownEmailIds: string[] = [];
  const missingFolders: string[] = [];
  // Одно письмо — одно перемещение (архив/папка/корзина), как в правилах плана.
  const moved = new Set<string>();

  actions.forEach((action, index) => {
    const message = byId.get(action.emailId);
    if (!message || message.folder.uidValidity === null) {
      unknownEmailIds.push(action.emailId);
      return;
    }
    if (action.type === 'MOVE') {
      const folders = foldersByMailbox.get(message.mailboxId) ?? [];
      if (!action.folderPath || !folders.some((f) => f.path === action.folderPath)) {
        missingFolders.push(action.folderPath ?? '(не указана)');
        return;
      }
    }
    const terminal = action.type === 'ARCHIVE' || action.type === 'MOVE' || action.type === 'TRASH';
    if (terminal) {
      if (moved.has(message.id)) return;
      moved.add(message.id);
    }
    const list = byMailbox.get(message.mailboxId) ?? [];
    list.push({
      localId: `c${index}`,
      type: action.type,
      stableObjectIds: [message.id],
      sourceLocators: { folderPath: message.folder.path, uidValidity: message.folder.uidValidity, uid: message.uid },
      reason: action.reason || 'Предложено ассистентом по вашей просьбе',
      relevance: 'RECOMMENDED',
      // ARCHIVE — без папки: исполнитель сам найдёт или создаст архив ящика.
      parameters: action.type === 'MOVE' ? { folderPath: action.folderPath } : {},
    });
    byMailbox.set(message.mailboxId, list);
  });

  return { byMailbox, unknownEmailIds, missingFolders };
}

// Сводка для карточки и для модели: «В архив — 3, Флажок — 1».
export function summarizeCandidates(candidates: MailActionCandidate[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => ({ type, count }));
}

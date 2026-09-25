// Stage 2, Phase R — производный статус ответа по треду (ТЗ разд. 12).

export type ReplyStatus = 'AWAITING_MY_REPLY' | 'REPLIED' | 'NO_REPLY_REQUIRED' | 'AWAITING_THEIR_REPLY' | 'UNKNOWN';

export interface ThreadMessageState {
  at: Date; // receivedAt || sentAt
  isOutgoing: boolean;
  isAutomated: boolean;
  // Результат AI-анализа последнего входящего: null — ещё не анализировалось.
  needsReply: boolean | null;
}

// Смотрим на ПОСЛЕДНЕЕ письмо треда — цепочка «входящее → исходящее → новое
// входящее» естественно переоценивается (новое входящее становится последним).
export function deriveReplyStatus(messages: ThreadMessageState[]): ReplyStatus {
  if (messages.length === 0) return 'UNKNOWN';
  const sorted = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  const last = sorted[sorted.length - 1];

  if (last.isOutgoing) {
    // За входящим есть более позднее исходящее → мы ответили. Если входящих не
    // было вовсе (мы написали первыми) — ждём ответа от них.
    return sorted.some((m) => !m.isOutgoing) ? 'REPLIED' : 'AWAITING_THEIR_REPLY';
  }

  if (last.isAutomated) return 'NO_REPLY_REQUIRED';
  if (last.needsReply === true) return 'AWAITING_MY_REPLY';
  if (last.needsReply === false) return 'NO_REPLY_REQUIRED';
  return 'UNKNOWN';
}

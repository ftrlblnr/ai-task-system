// Stage 2, Phase R — реконструкция тредов (ТЗ разд. 9). IMAP не даёт надёжной
// идентичности треда, поэтому: прежде всего Message-ID / In-Reply-To / References
// (граф связей, в т.ч. письма-«дети» раньше «родителей»), и ТОЛЬКО при полном
// отсутствии заголовков связи — фолбэк по нормализованной теме + участникам +
// близости по времени. Тема — НЕ единственный ключ. Модуль чистый: доступ к
// хранилищу через ThreadIndex (в синке — Prisma, в тестах — память).

const SUBJECT_PREFIX = /^\s*((re|fwd?|fw|ответ|пересл|отв|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i;
const SUBJECT_FALLBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? '').replace(SUBJECT_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface ThreadCandidateForSubject {
  threadId: string;
  participants: Set<string>;
  lastMessageAt: Date;
}

export interface ThreadIndex {
  // Треды, в которых уже есть письма с одним из этих Message-ID (родители).
  findThreadIdsByMessageIds(ids: string[]): Promise<string[]>;
  // Треды, чьи письма ссылаются на данный Message-ID (дети, пришедшие раньше).
  findThreadIdsReferencing(messageId: string): Promise<string[]>;
  // Недавние треды с такой же нормализованной темой (только для фолбэка).
  findRecentThreadsBySubject(subjectNorm: string, since: Date): Promise<ThreadCandidateForSubject[]>;
}

export interface ThreadInput {
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  participants: string[]; // адреса from/to/cc в нижнем регистре
  receivedAt: Date;
}

export interface ThreadResolution {
  // Найденные треды (>1 — письмо связало ранее разные треды: вызывающий сливает их).
  threadIds: string[];
  strategy: 'headers' | 'subject' | 'new';
}

export async function resolveThread(input: ThreadInput, index: ThreadIndex): Promise<ThreadResolution> {
  const refs = [input.inReplyTo, ...input.references].filter((r): r is string => Boolean(r));
  const found = new Set<string>();

  if (refs.length > 0) for (const id of await index.findThreadIdsByMessageIds(refs)) found.add(id);
  if (input.internetMessageId) for (const id of await index.findThreadIdsReferencing(input.internetMessageId)) found.add(id);
  if (found.size > 0) return { threadIds: [...found], strategy: 'headers' };

  // Фолбэк по теме — только если у письма нет заголовков связи вообще. Иначе тема
  // склеила бы несвязанные переписки с одинаковым заголовком («Счёт», «Договор»).
  const hasLinkHeaders = refs.length > 0;
  const subjectNorm = normalizeSubject(input.subject);
  if (!hasLinkHeaders && subjectNorm) {
    const since = new Date(input.receivedAt.getTime() - SUBJECT_FALLBACK_WINDOW_MS);
    const candidates = await index.findRecentThreadsBySubject(subjectNorm, since);
    const mine = new Set(input.participants);
    const match = candidates
      .filter((c) => Math.abs(input.receivedAt.getTime() - c.lastMessageAt.getTime()) <= SUBJECT_FALLBACK_WINDOW_MS)
      .filter((c) => [...c.participants].some((p) => mine.has(p)))
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())[0];
    if (match) return { threadIds: [match.threadId], strategy: 'subject' };
  }

  return { threadIds: [], strategy: 'new' };
}

// Краткосрочная память (ARMS, фаза 1.2): сообщения, выпавшие из окна
// истории (HISTORY_LIMIT), не теряются, а сворачиваются в сводку «с
// умыслом» — что сохранить обязательно, задано правилами ниже. Чистые
// функции — тестируются без ключа.

export const COMPACTION_RULES = `Обязательно сохрани:
- принятые решения и договорённости;
- поручения: кто, что, к какому сроку (имена и даты как в тексте);
- названные даты, суммы, номера, названия объектов и документов;
- открытые вопросы — что пользователь спросил, а ответа ещё нет;
- что пользователь просил сделать дальше.
Отбрось приветствия, благодарности, повторы, служебные пометки ([shown_task] и т.п.) и пересказ того, что ассистент просто показал списком.
Пиши по-русски коротко, пунктами, в прошедшем времени, без вступлений. Не выдумывай того, чего нет в сообщениях.`;

// ≈1–1,5 тыс. токенов — сводка вставляется в каждый ответ.
export const SUMMARY_MAX_CHARS = 4000;
// Сворачиваем, когда за окном набралось столько сообщений (реже — дешевле;
// история до сжатия держит до HISTORY_LIMIT + COMPACT_MIN_BATCH сообщений).
export const COMPACT_MIN_BATCH = 6;
// За один раз — не больше; при первом сжатии длинного разговора более
// старые сообщения отбрасываются, как и раньше (без «догоняющей» серии вызовов).
export const COMPACT_MAX_BATCH = 60;

export interface CompactionMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: Date;
}

// unsummarizedAsc — сообщения новее summaryUpToAt, от старых к новым.
export function selectMessagesToCompact<T extends { createdAt: Date }>(unsummarizedAsc: T[], historyLimit: number): T[] {
  const beyondWindow = unsummarizedAsc.length - historyLimit;
  if (beyondWindow < COMPACT_MIN_BATCH) return [];
  return unsummarizedAsc.slice(0, beyondWindow).slice(-COMPACT_MAX_BATCH);
}

export function buildCompactionSystem(): string {
  return `Ты сворачиваешь раннюю часть переписки руководителя с ассистентом в рабочую сводку, которую ассистент будет видеть вместо этих сообщений.\n${COMPACTION_RULES}\nДлина сводки — не больше ${SUMMARY_MAX_CHARS} символов: если не помещается, сокращай старое и мелкое, а не решения и поручения.`;
}

export function buildCompactionUser(previousSummary: string | null, messages: CompactionMessage[]): string {
  const prev = previousSummary?.trim() ? `Сводка более ранней части (дополни её, не теряя важного):\n${previousSummary.trim()}\n\n` : '';
  const lines = messages.map((m) => {
    const who = m.role === 'user' ? 'Пользователь' : 'Ассистент';
    const day = m.createdAt.toISOString().slice(0, 10);
    return `[${day}] ${who}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 2000)}`;
  });
  return `${prev}Новые сообщения для сводки:\n${lines.join('\n')}\n\nВерни обновлённую сводку целиком.`;
}

export function clampSummary(text: string): string {
  const clean = text.trim();
  return clean.length <= SUMMARY_MAX_CHARS ? clean : `${clean.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

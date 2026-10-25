import { buildCompactionUser, clampSummary, COMPACT_MAX_BATCH, COMPACT_MIN_BATCH, COMPACTION_RULES, selectMessagesToCompact, SUMMARY_MAX_CHARS } from './conversation-summary';

const at = (i: number) => ({ id: `m${i}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)) });

describe('selectMessagesToCompact', () => {
  it('пока за окном мало сообщений — не сжимаем', () => {
    const msgs = Array.from({ length: 20 + COMPACT_MIN_BATCH - 1 }, (_, i) => at(i));
    expect(selectMessagesToCompact(msgs, 20)).toEqual([]);
  });

  it('сжимает всё, что старше окна', () => {
    const msgs = Array.from({ length: 20 + COMPACT_MIN_BATCH }, (_, i) => at(i));
    expect(selectMessagesToCompact(msgs, 20).map((m) => m.id)).toEqual(msgs.slice(0, COMPACT_MIN_BATCH).map((m) => m.id));
  });

  it('длинный старый разговор — только последние COMPACT_MAX_BATCH перед окном', () => {
    const msgs = Array.from({ length: 300 }, (_, i) => at(i));
    const batch = selectMessagesToCompact(msgs, 20);
    expect(batch).toHaveLength(COMPACT_MAX_BATCH);
    expect(batch[batch.length - 1].id).toBe('m279');
  });
});

describe('правила сжатия', () => {
  it('обязательно сохраняют решения, поручения, даты/суммы и открытые вопросы', () => {
    for (const must of ['решения', 'поручения', 'даты, суммы', 'открытые вопросы']) expect(COMPACTION_RULES).toContain(must);
  });

  it('промпт дополняет прежнюю сводку и помечает авторов', () => {
    const user = buildCompactionUser('- Решили перенести сдачу на 15.11', [
      { role: 'user', text: 'Поручи Жандосу смету до пятницы', createdAt: new Date('2026-10-20T05:00:00Z') },
      { role: 'assistant', text: 'Поставил задачу', createdAt: new Date('2026-10-20T05:01:00Z') },
    ]);
    expect(user).toContain('Сводка более ранней части');
    expect(user).toContain('- Решили перенести сдачу на 15.11');
    expect(user).toContain('[2026-10-20] Пользователь: Поручи Жандосу смету до пятницы');
    expect(user).toContain('Ассистент: Поставил задачу');
  });

  it('сводка не длиннее лимита', () => {
    expect(clampSummary('x'.repeat(SUMMARY_MAX_CHARS + 100))).toHaveLength(SUMMARY_MAX_CHARS);
  });
});

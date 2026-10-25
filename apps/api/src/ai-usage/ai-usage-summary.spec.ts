import { callCostUsd } from './ai-usage-prices';
import { percentile, summarizeAiCalls, type AiCallRow } from './ai-usage-summary';

function call(over: Partial<AiCallRow>): AiCallRow {
  return {
    feature: 'assistant.reply',
    model: 'claude-haiku-5-5',
    latencyMs: 1000,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    audioMs: null,
    ok: true,
    createdAt: new Date('2026-10-24T06:00:00Z'),
    ...over,
  };
}

describe('callCostUsd', () => {
  it('считает вход, выход, чтение и запись кэша по цене модели', () => {
    // Haiku 5.5: 0.10 вход, 0.50 выход, 0.01 чтение, запись ×1.25 = 0.125.
    const usd = callCostUsd({ model: 'claude-haiku-5-5', inputTokens: 40_000, outputTokens: 40_000, cacheReadTokens: 40_000, cacheWriteTokens: 0 });
    expect(usd).toBeCloseTo((40_000 * 0.1 + 40_000 * 0.5 + 40_000 * 0.01) / 1_000_000, 10);
    expect(callCostUsd({ model: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 80_000 })).toBeCloseTo(0.01, 10);
    // Из них 40K — кэш на 1 час: ×2 вместо ×1.25.
    expect(callCostUsd({ model: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 80_000, cacheWrite1hTokens: 40_000 })).toBeCloseTo(
      (40_000 * 0.1 * 1.25 + 40_000 * 0.1 * 2) / 1_000_000,
      10,
    );
  });

  it('берёт цену длинного запроса Haiku выше 100K токенов (вход + кэш)', () => {
    const usd = callCostUsd({ model: 'claude-haiku-5-5', inputTokens: 60_000, outputTokens: 1000, cacheReadTokens: 50_000, cacheWriteTokens: 0 });
    expect(usd).toBeCloseTo((60_000 * 0.5 + 50_000 * 0.05 + 1000 * 2.5) / 1_000_000);
  });

  it('модель без цены (OpenAI) — null', () => {
    expect(callCostUsd({ model: 'gpt-transcribe', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null })).toBeNull();
  });
});

describe('percentile', () => {
  it('ближайший ранг', () => {
    expect(percentile([100, 200, 300, 400], 50)).toBe(200);
    expect(percentile([100, 200, 300, 400], 95)).toBe(400);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('summarizeAiCalls', () => {
  const from = new Date('2026-10-18T19:00:00Z'); // 19.10 00:00 по Алматы
  const to = new Date('2026-10-25T10:00:00Z');
  const base = { days: 7, from, to, pricesAsOf: '2026-10-25', lastCallByFeature: [] };

  it('группирует по функции, сортирует по стоимости, считает долю кэша и вызовы без цены', () => {
    const s = summarizeAiCalls({
      ...base,
      groupBy: 'feature',
      calls: [
        call({ feature: 'mail.analysis', inputTokens: 90_000, outputTokens: 0, latencyMs: 500 }),
        call({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 10, latencyMs: 2000 }),
        call({ ok: false, latencyMs: 60_000 }),
        call({ feature: 'stt', model: 'gpt-transcribe', audioMs: 12_400 }),
      ],
    });
    expect(s.rows.map((r) => r.key)).toEqual(['mail.analysis', 'assistant.reply', 'stt']);
    const assistant = s.rows[1];
    expect(assistant.calls).toBe(2);
    expect(assistant.errors).toBe(1);
    expect(assistant.cacheShare).toBeCloseTo(0.9);
    // Сбой не попадает в латентность.
    expect(assistant.p95LatencyMs).toBe(2000);
    const stt = s.rows[2];
    expect(stt.unpricedCalls).toBe(1);
    expect(stt.costPerCallUsd).toBeNull();
    expect(stt.cacheShare).toBeNull();
    expect(stt.audioSeconds).toBe(12);
    expect(s.total.calls).toBe(4);
    expect(s.total.unpricedCalls).toBe(1);
    expect(s.total.costUsd).toBeCloseTo((90_000 * 0.1 + 100 * 0.1 + 900 * 0.01 + 10 * 0.5) / 1_000_000, 10);
  });

  it('группирует по модели', () => {
    const s = summarizeAiCalls({ ...base, groupBy: 'model', calls: [call({}), call({ feature: 'mail.analysis' }), call({ model: 'claude-opus-5' })] });
    expect(s.rows.find((r) => r.key === 'claude-haiku-5-5')?.calls).toBe(2);
    expect(s.rows.find((r) => r.key === 'claude-opus-5')?.calls).toBe(1);
  });

  it('раскладывает по дням времени компании, все дни периода присутствуют', () => {
    const s = summarizeAiCalls({
      ...base,
      groupBy: 'feature',
      // 20:00 UTC 24.10 — уже 25.10 по Алматы.
      calls: [call({ createdAt: new Date('2026-10-24T20:00:00Z'), inputTokens: 50_000 })],
    });
    expect(s.daily).toHaveLength(7);
    expect(s.daily[0].date).toBe('2026-10-19');
    expect(s.daily[6]).toEqual({ date: '2026-10-25', calls: 1, costUsd: expect.closeTo(0.005, 10) });
  });

  it('кандидаты на отключение — функции без вызовов 30 дней', () => {
    const s = summarizeAiCalls({
      ...base,
      groupBy: 'feature',
      calls: [],
      lastCallByFeature: [
        { feature: 'meetings.task-extraction', lastCallAt: new Date('2026-09-01T00:00:00Z') },
        { feature: 'assistant.reply', lastCallAt: new Date('2026-10-24T00:00:00Z') },
      ],
    });
    expect(s.idle).toEqual([{ key: 'meetings.task-extraction', lastCallAt: '2026-09-01T00:00:00.000Z' }]);
  });
});

import type { AiUsageGroupBy, AiUsageRow, AiUsageSummary, AiUsageTotals } from '@ai-task-system/shared-types';
import { localDateString } from '../common/timezone';
import { callCostUsd } from './ai-usage-prices';

// Чистая сводка журнала AiCall для экрана «Расход ИИ» (ARMS, фаза 2):
// сервис только достаёт строки за период, вся арифметика — здесь, под тестом.

export interface AiCallRow {
  feature: string;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens?: number | null;
  audioMs: number | null;
  ok: boolean;
  createdAt: Date;
}

function emptyTotals(): AiUsageTotals {
  return { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheShare: null, costUsd: 0, unpricedCalls: 0, audioSeconds: 0 };
}

function add(t: AiUsageTotals, c: AiCallRow, cost: number | null) {
  t.calls += 1;
  if (!c.ok) t.errors += 1;
  t.inputTokens += c.inputTokens ?? 0;
  t.outputTokens += c.outputTokens ?? 0;
  t.cacheReadTokens += c.cacheReadTokens ?? 0;
  t.cacheWriteTokens += c.cacheWriteTokens ?? 0;
  t.audioSeconds += (c.audioMs ?? 0) / 1000;
  if (cost === null) t.unpricedCalls += 1;
  else t.costUsd += cost;
}

function finish(t: AiUsageTotals): AiUsageTotals {
  const prompt = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return { ...t, cacheShare: prompt > 0 ? t.cacheReadTokens / prompt : null, audioSeconds: Math.round(t.audioSeconds) };
}

// Ближайший ранг: p50 из [100, 200, 300, 400] — 200.
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

export function summarizeAiCalls(params: {
  calls: AiCallRow[];
  groupBy: AiUsageGroupBy;
  days: number;
  from: Date;
  to: Date;
  pricesAsOf: string;
  lastCallByFeature: { feature: string; lastCallAt: Date }[];
  idleAfterDays?: number;
}): AiUsageSummary {
  const { calls, groupBy, days, from, to } = params;
  const total = emptyTotals();
  const groups = new Map<string, { totals: AiUsageTotals; latencies: number[]; lastCallAt: Date }>();
  const daily = new Map<string, { costUsd: number; calls: number }>();
  for (let i = 0; i < days; i++) daily.set(localDateString(new Date(from.getTime() + i * 86_400_000)), { costUsd: 0, calls: 0 });

  for (const c of calls) {
    const cost = callCostUsd(c);
    add(total, c, cost);
    const key = groupBy === 'model' ? c.model : c.feature;
    let g = groups.get(key);
    if (!g) {
      g = { totals: emptyTotals(), latencies: [], lastCallAt: c.createdAt };
      groups.set(key, g);
    }
    add(g.totals, c, cost);
    // Сбой — не время ответа: таймауты и отказы исказили бы p95.
    if (c.ok) g.latencies.push(c.latencyMs);
    if (c.createdAt > g.lastCallAt) g.lastCallAt = c.createdAt;
    const day = daily.get(localDateString(c.createdAt));
    if (day) {
      day.calls += 1;
      day.costUsd += cost ?? 0;
    }
  }

  const rows: AiUsageRow[] = [...groups.entries()].map(([key, g]) => {
    const latencies = g.latencies.sort((a, b) => a - b);
    const totals = finish(g.totals);
    const priced = totals.calls - totals.unpricedCalls;
    return {
      key,
      ...totals,
      costPerCallUsd: priced > 0 ? totals.costUsd / priced : null,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      lastCallAt: g.lastCallAt.toISOString(),
    };
  });
  rows.sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  const idleBefore = to.getTime() - (params.idleAfterDays ?? 30) * 86_400_000;
  const idle = params.lastCallByFeature
    .filter((f) => f.lastCallAt.getTime() < idleBefore)
    .sort((a, b) => a.lastCallAt.getTime() - b.lastCallAt.getTime())
    .map((f) => ({ key: f.feature, lastCallAt: f.lastCallAt.toISOString() }));

  return {
    days,
    groupBy,
    from: from.toISOString(),
    to: to.toISOString(),
    pricesAsOf: params.pricesAsOf,
    total: finish(total),
    rows,
    daily: [...daily.entries()].map(([date, d]) => ({ date, ...d })),
    idle,
  };
}

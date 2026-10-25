// Цены моделей для экрана «Расход ИИ» (ARMS, фаза 2) — оценка, не счёт:
// точная сумма — в консоли Anthropic. $ за 1 млн токенов, сверено со
// справочником claude-api на PRICES_AS_OF. Кэш: чтение — доля от цены входа,
// запись кэша — ×1.25 (TTL 5 минут) или ×2 (TTL 1 час).
// Модели OpenAI (расшифровка, живой голос) сюда не внесены: токенов их
// вызовы не пишут, а цены за минуту в справочнике нет — экран показывает их
// отдельно как «без оценки».
export const PRICES_AS_OF = '2026-10-25';

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  // Haiku 5.5: дороже, если запрос длиннее порога (вход + кэш).
  longContext?: { aboveTokens: number; input: number; output: number; cacheRead: number };
}

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
};

export interface PricedTokens {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens?: number | null;
}

// null — модель без цены (вызов не входит в сумму).
export function callCostUsd(call: PricedTokens): number | null {
  const price = MODEL_PRICES[call.model];
  if (!price) return null;
  const input = call.inputTokens ?? 0;
  const cacheRead = call.cacheReadTokens ?? 0;
  const cacheWrite = call.cacheWriteTokens ?? 0;
  const cacheWrite1h = Math.min(call.cacheWrite1hTokens ?? 0, cacheWrite);
  const prompt = input + cacheRead + cacheWrite;
  const rate = price.longContext && prompt > price.longContext.aboveTokens ? price.longContext : price;
  const usd =
    input * rate.input +
    (cacheWrite - cacheWrite1h) * rate.input * CACHE_WRITE_MULTIPLIER +
    cacheWrite1h * rate.input * CACHE_WRITE_1H_MULTIPLIER +
    cacheRead * rate.cacheRead +
    (call.outputTokens ?? 0) * rate.output;
  return usd / 1_000_000;
}

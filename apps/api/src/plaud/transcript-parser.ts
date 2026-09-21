// Stage 2, Phase K (внешний аудит 21.09.2026, "MeetingSegment + transcript
// ingestion") — ⚠️ формат входных данных НЕ подтверждён живым вызовом
// Plaud API (см. комментарий у PlaudApiService.findTranscriptNote) — это
// best-effort парсер под ПРЕДПОЛАГАЕМЫЙ формат (JSON-массив сегментов с
// говорящим/таймкодами/текстом, самый распространённый вид у
// ASR-транскрипции). Разбит на чистую функцию отдельно от
// PlaudApiService/PlaudSyncService намеренно — сама логика
// разбора+валидации полностью тестируема независимо от вопроса "что
// именно возвращает Plaud" (тот тестировать нечем без реального
// аккаунта). Если реальный формат окажется другим, поправить нужно только
// этот файл — весь остальной pipeline (сохранение в MeetingSegment) не
// зависит от того, откуда взялись сегменты.
export interface TranscriptSegmentInput {
  order: number;
  startMs: number;
  endMs: number;
  speakerLabel: string;
  text: string;
}

interface RawSegmentCandidate {
  speaker?: unknown;
  speaker_label?: unknown;
  speakerLabel?: unknown;
  start?: unknown;
  start_time?: unknown;
  startMs?: unknown;
  start_ms?: unknown;
  end?: unknown;
  end_time?: unknown;
  endMs?: unknown;
  end_ms?: unknown;
  text?: unknown;
  content?: unknown;
}

function pickString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

// Секунды vs миллисекунды — ещё одна неопределённость формата: значения
// <= 24h в секундах обычно намного меньше, чем в мс, для типичной
// длительности встречи (минуты-часы) — эвристика "меньше 100000 → скорее
// всего секунды, домножить на 1000" достаточно надёжна для реальных
// длительностей встреч (до ~27 часов в секундах), но это тоже
// предположение, не факт.
function pickMs(...values: unknown[]): number | null {
  for (const v of values) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0) continue;
    return n < 100_000 ? Math.round(n * 1000) : Math.round(n);
  }
  return null;
}

export function parseTranscriptSegments(raw: string): TranscriptSegmentInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.segments) ? (parsed as any).segments : null;
  if (!list) return [];

  const segments: TranscriptSegmentInput[] = [];
  let order = 0;
  for (const item of list as RawSegmentCandidate[]) {
    if (!item || typeof item !== 'object') continue;
    const text = pickString(item.text, item.content);
    if (!text) continue;
    const speakerLabel = pickString(item.speaker, item.speaker_label, item.speakerLabel) ?? 'Неизвестный говорящий';
    const startMs = pickMs(item.startMs, item.start_ms, item.start, item.start_time) ?? 0;
    const endMs = pickMs(item.endMs, item.end_ms, item.end, item.end_time) ?? startMs;
    segments.push({ order: order++, startMs, endMs, speakerLabel, text });
  }
  return segments;
}

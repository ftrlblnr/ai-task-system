// Stage 2, Phase M (внешний аудит 21.09.2026) — формат ПОДТВЕРЖДЁН живым
// вызовом реального Plaud API 21.09.2026 (см. PlaudApiService.findTranscriptNote):
// JSON-массив объектов вида {content, start_time, end_time, speaker,
// original_speaker, embeddingKey}, start_time/end_time уже в миллисекундах
// (проверено: короткая реплика в начале записи имела start_time=8790,
// т.е. 8.79 сек от начала — не 8790 секунд). Поля start/end (без _time) и
// speaker_label/speakerLabel/text/startMs/endMs — остаются в парсере как
// толерантность к вариациям (обёрнутый {segments:[...]}, альтернативные
// имена полей), но реальный, подтверждённый формат Plaud — start_time/
// end_time/content/speaker. Разбит на чистую функцию отдельно от
// PlaudApiService/PlaudSyncService — сама логика разбора+валидации
// тестируема независимо (см. spec с fixture реального формата).
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

function toFiniteNonNegative(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Находка №4 пятого внешнего аудита (Stage 2, Phase L) — раньше одна и та
// же "< 100000 → скорее всего секунды" эвристика применялась и к полям,
// чьё ИМЯ уже однозначно называет единицу (startMs/start_ms), из-за чего
// реальное значение в миллисекундах меньше 100000 (первые ~1:40 записи)
// молча домножалось на 1000 ещё раз — опасная порча данных именно там, где
// формат был известен точно, не там, где он неоднозначен. Явные *Ms/*_ms
// поля теперь берутся как есть, без какой-либо эвристики.
//
// Stage 2, Phase M — start_time/end_time ТОЖЕ перенесены сюда (были в
// pickAmbiguousMs): живой вызов реального Plaud API 21.09.2026 подтвердил,
// что у Plaud start_time/end_time всегда уже в миллисекундах, несмотря на
// то что имя поля само по себе не содержит "ms" — предыдущая эвристика
// молча домножала бы 8790 (8.79 сек от начала записи) на 1000, превращая
// его в ~2.4 часа. Раз для КОНКРЕТНО этих имён полей единица теперь
// эмпирически известна (не предположение), их место — здесь, а не в
// pickAmbiguousMs.
function pickExplicitMs(...values: unknown[]): number | null {
  for (const v of values) {
    const n = toFiniteNonNegative(v);
    if (n !== null) return Math.round(n);
  }
  return null;
}

// Секунды vs миллисекунды — здесь имя поля (голое start/end, без _time)
// само по себе не уточняет единицу и реального подтверждения у Plaud для
// него нет (Plaud использует start_time/end_time, см. pickExplicitMs
// выше): эвристика "меньше 100000 → скорее всего секунды, домножить на
// 1000" остаётся как последняя линия обороны на случай нестандартного/
// стороннего формата, не как основной путь для Plaud.
function pickAmbiguousMs(...values: unknown[]): number | null {
  for (const v of values) {
    const n = toFiniteNonNegative(v);
    if (n === null) continue;
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
  const wrapped = parsed && typeof parsed === 'object' ? (parsed as { segments?: unknown }).segments : undefined;
  const list = Array.isArray(parsed) ? parsed : Array.isArray(wrapped) ? wrapped : null;
  if (!list) return [];

  const segments: TranscriptSegmentInput[] = [];
  let order = 0;
  for (const item of list as RawSegmentCandidate[]) {
    if (!item || typeof item !== 'object') continue;
    const text = pickString(item.text, item.content);
    if (!text) continue;
    const speakerLabel = pickString(item.speaker, item.speaker_label, item.speakerLabel) ?? 'Неизвестный говорящий';
    const startMs = pickExplicitMs(item.startMs, item.start_ms, item.start_time) ?? pickAmbiguousMs(item.start) ?? 0;
    const endMs = pickExplicitMs(item.endMs, item.end_ms, item.end_time) ?? pickAmbiguousMs(item.end) ?? startMs;
    segments.push({ order: order++, startMs, endMs, speakerLabel, text });
  }
  return segments;
}

import { normalizeAliasText } from '../employees/employee-resolver.service';

// «Похоже на уже существующую задачу» (AGENT_AND_MEETINGS.md, B.4) —
// эвристика по словам названия, не вызов модели: только помечает
// предложение, решает руководитель (по умолчанию похожее не выбрано).

export const SIMILARITY_THRESHOLD = 0.6;

// Русские падежи — общий префикс, как в EmployeeResolverService: от слова
// остаётся 4–5 первых букв, окончание срезается («сметы»/«смету» → «смет»,
// «отчёт»/«отчета» → «отче», «договор»/«договора» → «догов»). Короткие
// служебные слова («к», «на», «по») не учитываются.
const MIN_WORD_CHARS = 3;

function stem(word: string): string {
  return word.length <= 4 ? word : word.slice(0, Math.max(4, Math.min(5, word.length - 2)));
}

export function titleWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w.length >= MIN_WORD_CHARS)
    .map(stem);
  return new Set(words);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return common / (a.size + b.size - common);
}

// Одно поручение из двух перекрывающихся окон расшифровки: тот же
// исполнитель (как прозвучал) и близкое название.
export function sameTask(titleA: string, assigneeA: string | null, titleB: string, assigneeB: string | null): boolean {
  const who = (s: string | null) => (s ? normalizeAliasText(s) : '');
  return who(assigneeA) === who(assigneeB) && jaccard(titleWords(titleA), titleWords(titleB)) >= SIMILARITY_THRESHOLD;
}

export interface ExistingTask {
  id: string;
  title: string;
  assigneeId: string | null;
  sourceMeetingId: string | null;
}

// Сравниваем с открытыми задачами этой встречи (любой исполнитель — их
// уже поставили из неё вручную или прошлым разбором) и открытыми задачами
// того же исполнителя; лучшее совпадение выше порога.
export function findSimilarTask(
  proposal: { title: string; assigneeId: string | null },
  meetingId: string,
  tasks: ExistingTask[],
): string | null {
  const words = titleWords(proposal.title);
  let best: { id: string; score: number } | null = null;
  for (const t of tasks) {
    const relevant = t.sourceMeetingId === meetingId || (proposal.assigneeId !== null && t.assigneeId === proposal.assigneeId);
    if (!relevant) continue;
    const score = jaccard(words, titleWords(t.title));
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { id: t.id, score };
  }
  return best?.id ?? null;
}

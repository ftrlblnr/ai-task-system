// Whisper с `prompt` (словарь имён сотрудников/терминов, см.
// CompanyVocabularyService) на неразборчивой, слишком короткой или почти тихой
// записи иногда возвращает саму подсказку как «транскрипт». Раньше такой
// ответ принимался как команда пользователя: 24.09.2026 вместо «поставь задачу
// Азамату…» система «услышала» «Мухамедкаримов Азамат, GLB, Plaud, IDAT, Revit,
// BIM», ничего не выполнила и записала мусор в общую ленту (а он потом отравил
// контекст следующей команды).

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isPromptEcho(text: string, prompt: string): boolean {
  const t = normalize(text);
  const p = normalize(prompt);
  if (!t || !p) return false;
  if (t === p) return true;

  const words = t.split(' ');
  // Одно-два слова — обычный короткий ответ («Азамат»), не эхо списка.
  if (words.length < 3) return false;
  // Обрезанное эхо: начало подсказки.
  if (p.startsWith(t)) return true;
  // Почти все слова из подсказки.
  const promptWords = new Set(p.split(' '));
  return words.filter((w) => promptWords.has(w)).length / words.length >= 0.9;
}

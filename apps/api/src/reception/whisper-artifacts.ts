// Whisper на тишине, шуме или слишком короткой записи по-русски выдаёт
// «субтитровые» галлюцинации из обучающих данных («Продолжение следует...»,
// «Субтитры сделал DimaTorzok»). Найдено в проде 21.10.2026: такой текст
// уходил на редактуру, и модель отвечала на него комментарием или сочиняла
// ответ от себя.
const MARKERS = [
  'продолжение следует',
  'субтитр',
  'dimatorzok',
  'торжок',
  'редактор субтитров',
  'корректор',
  'спасибо за просмотр',
  'подписывайтесь',
  'ставьте лайк',
  'до новых встреч',
  'amara',
  'амара',
];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// true — в записи нет речи, только артефакт. Длинный текст с таким словом
// внутри («…субтитры к видео подготовьте…») артефактом не считается.
export function isWhisperArtifact(text: string): boolean {
  const t = normalize(text);
  if (!t) return true;
  if (t.split(' ').length > 8) return false;
  return MARKERS.some((m) => t.includes(m));
}

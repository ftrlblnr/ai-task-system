import { parseTranscriptSegments } from './transcript-parser';

describe('parseTranscriptSegments', () => {
  it('невалидный JSON — пустой массив, не бросает', () => {
    expect(parseTranscriptSegments('не json')).toEqual([]);
  });

  it('JSON не массив и не {segments: [...]} — пустой массив', () => {
    expect(parseTranscriptSegments('{"foo": "bar"}')).toEqual([]);
  });

  it('простой массив сегментов (speaker/start/end в секундах) — парсится, время переводится в мс', () => {
    const raw = JSON.stringify([
      { speaker: 'Speaker 1', start: 0, end: 5.2, text: 'Привет всем' },
      { speaker: 'Speaker 2', start: 5.2, end: 12, text: 'Добрый день' },
    ]);

    const result = parseTranscriptSegments(raw);

    expect(result).toEqual([
      { order: 0, startMs: 0, endMs: 5200, speakerLabel: 'Speaker 1', text: 'Привет всем' },
      { order: 1, startMs: 5200, endMs: 12000, speakerLabel: 'Speaker 2', text: 'Добрый день' },
    ]);
  });

  it('обёрнуто в {segments: [...]}', () => {
    const raw = JSON.stringify({ segments: [{ speaker_label: 'A', start_time: 1, end_time: 2, content: 'Текст' }] });

    const result = parseTranscriptSegments(raw);

    expect(result).toEqual([{ order: 0, startMs: 1000, endMs: 2000, speakerLabel: 'A', text: 'Текст' }]);
  });

  it('время уже в миллисекундах (большие значения) — не домножается повторно', () => {
    const raw = JSON.stringify([{ speaker: 'A', startMs: 120000, endMs: 125000, text: 'Через две минуты' }]);

    const result = parseTranscriptSegments(raw);

    expect(result).toEqual([{ order: 0, startMs: 120000, endMs: 125000, speakerLabel: 'A', text: 'Через две минуты' }]);
  });

  // РЕГРЕССИЯ находки №4 пятого внешнего аудита (Stage 2, Phase L) — раньше
  // эвристика "< 100000 → секунды" применялась даже к полям startMs/endMs,
  // чьё имя уже однозначно говорит "это миллисекунды". Сегмент из первых
  // ~1:40 записи (значение меньше порога 100000) домножался на 1000 ещё
  // раз — 5 секунд превращались в 5000 секунд (~1.4ч), что рвало и
  // сортировку сегментов, и любое отображение таймкода.
  it('время уже в миллисекундах, но МЕНЬШЕ порога эвристики (начало записи) — тоже не домножается', () => {
    const raw = JSON.stringify([{ speaker: 'A', startMs: 5000, endMs: 8000, text: 'В самом начале записи' }]);

    const result = parseTranscriptSegments(raw);

    expect(result).toEqual([{ order: 0, startMs: 5000, endMs: 8000, speakerLabel: 'A', text: 'В самом начале записи' }]);
  });

  it('start_ms (snake_case, явно мс) — тоже без эвристики, даже если значение маленькое', () => {
    const raw = JSON.stringify([{ speaker: 'A', start_ms: 1500, end_ms: 3000, text: 'Ещё раньше' }]);

    const result = parseTranscriptSegments(raw);

    expect(result).toEqual([{ order: 0, startMs: 1500, endMs: 3000, speakerLabel: 'A', text: 'Ещё раньше' }]);
  });

  it('неоднозначные start/end (без Ms в имени), маленькое значение — эвристика секунд по-прежнему работает', () => {
    const raw = JSON.stringify([{ speaker: 'A', start: 5, end: 8, text: 'В секундах' }]);

    const result = parseTranscriptSegments(raw);

    expect(result).toEqual([{ order: 0, startMs: 5000, endMs: 8000, speakerLabel: 'A', text: 'В секундах' }]);
  });

  it('сегмент без текста пропускается, остальные сохраняют порядок', () => {
    const raw = JSON.stringify([
      { speaker: 'A', start: 0, end: 1, text: 'Первый' },
      { speaker: 'B', start: 1, end: 2, text: '' },
      { speaker: 'A', start: 2, end: 3, text: 'Третий' },
    ]);

    const result = parseTranscriptSegments(raw);

    expect(result.map((s) => s.text)).toEqual(['Первый', 'Третий']);
    expect(result.map((s) => s.order)).toEqual([0, 1]);
  });

  it('без указания говорящего — fallback "Неизвестный говорящий"', () => {
    const raw = JSON.stringify([{ start: 0, end: 1, text: 'Без метки' }]);

    const result = parseTranscriptSegments(raw);

    expect(result[0].speakerLabel).toBe('Неизвестный говорящий');
  });
});

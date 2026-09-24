import { MAX_COMMENTARY_CHARS, toSpokenLiveReply } from './live-spoken-reply';

const task = (over: Record<string, unknown> = {}) => ({
  type: 'task_action' as const,
  ok: true,
  error: null,
  taskId: 't1',
  undoToken: null,
  draft: { type: 'task_action', action: 'create', title: 'Купить мясо', targetTitle: '', assigneeName: 'Азамат', dueDate: '2026-09-25T18:00:00', ...over },
});
const event = (over: Record<string, unknown> = {}, res: Record<string, unknown> = {}) => ({
  type: 'event_action' as const,
  ok: true,
  error: null,
  eventId: 'e1',
  undoToken: null,
  warning: null,
  draft: { type: 'event_action', action: 'create', title: 'Встреча с IDAT', targetTitle: '', startAt: '2026-09-25T15:00:00', allDay: false, ...over },
  ...res,
});
const say = (results: unknown[], clarificationReason: string | null = null) =>
  toSpokenLiveReply({ results: results as any, clarificationReason });

describe('toSpokenLiveReply — озвучка итога делегации GPT-Live', () => {
  it('создание задачи: название, исполнитель и срок (сценарий «поставь задачу Азамату купить мясо»)', () => {
    expect(say([task()])).toBe('Создал задачу «Купить мясо», исполнитель Азамат, срок 25 сентября в 18:00.');
  });

  it('создание события в календаре: дата и время', () => {
    expect(say([event()])).toBe('Добавил в календарь «Встреча с IDAT» на 25 сентября в 15:00.');
  });

  it('два действия в одной реплике — по порядку произнесения', () => {
    expect(say([task(), event()])).toBe(
      'Создал задачу «Купить мясо», исполнитель Азамат, срок 25 сентября в 18:00. Добавил в календарь «Встреча с IDAT» на 25 сентября в 15:00.',
    );
  });

  it('событие на весь день — без времени; задача без исполнителя и срока — без хвоста', () => {
    expect(say([event({ allDay: true })])).toContain('на 25 сентября.');
    expect(say([task({ assigneeName: null, dueDate: null })])).toBe('Создал задачу «Купить мясо».');
  });

  it('update/delete задачи и события', () => {
    expect(say([task({ action: 'update', title: 'Новое имя' })])).toBe('Обновил задачу «Новое имя».');
    expect(say([task({ action: 'delete', targetTitle: 'Старая' })])).toBe('Удалил задачу «Старая».');
    expect(say([event({ action: 'update', title: '' , targetTitle: 'Планёрка' })])).toBe('Изменил встречу «Планёрка».');
    expect(say([event({ action: 'delete', targetTitle: 'Планёрка' })])).toBe('Удалил встречу «Планёрка».');
  });

  it('ok=false — честная фраза о сбое БЕЗ текста ошибки и БЕЗ слов об успехе', () => {
    const failed = { ...task(), ok: false, error: 'db down: password=secret', taskId: null };

    const text = say([failed]);

    expect(text).toBe('Не удалось создать задачу «Купить мясо», подробности в чате.');
    expect(text).not.toContain('secret');
    expect(text).not.toMatch(/^Создал/);
  });

  it('частичный сбой участников события — оговорка без текста warning', () => {
    const text = say([event({}, { warning: 'Не удалось добавить участника X (внутренняя деталь)' })]);

    expect(text).toContain('С участниками возникла проблема');
    expect(text).not.toContain('внутренняя деталь');
  });

  it('chat-ответ озвучивается без markdown; уточнение добавляется, только если нет chat-ответа', () => {
    expect(say([{ type: 'chat', reply: '**Найдено** 3 задачи' }])).toBe('Найдено 3 задачи');
    expect(say([task({ assigneeName: null, dueDate: null })], 'Кому поставить?')).toContain('Кому поставить?');
    expect(say([{ type: 'chat', reply: 'Кому поставить?' }], 'Кому поставить?')).toBe('Кому поставить?');
  });

  it('пустой результат — нейтральная фраза; длинный ответ обрезается с пометкой про чат', () => {
    expect(say([])).toBe('Готово, подробности в чате.');

    const long = say([{ type: 'chat', reply: 'Предложение номер один. '.repeat(200) }]);

    expect(long.length).toBeLessThanOrEqual(MAX_COMMENTARY_CHARS);
    expect(long.endsWith('Подробности в чате.')).toBe(true);
  });
});

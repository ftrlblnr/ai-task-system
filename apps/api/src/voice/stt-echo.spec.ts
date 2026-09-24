import { isPromptEcho } from './stt-echo';

const PROMPT = 'Мухамедкаримов Азамат, GLB, Plaud, IDAT, Revit, BIM';

describe('isPromptEcho — Whisper вернул словарь-подсказку вместо речи (инцидент 24.09.2026)', () => {
  it('точное эхо подсказки (как в проде)', () => {
    expect(isPromptEcho('Мухамедкаримов Азамат, GLB, Plaud, IDAT, Revit, BIM', PROMPT)).toBe(true);
  });

  it('эхо с другой пунктуацией/регистром и обрезанное эхо (начало подсказки)', () => {
    expect(isPromptEcho('мухамедкаримов азамат glb plaud idat revit bim.', PROMPT)).toBe(true);
    expect(isPromptEcho('Мухамедкаримов Азамат, GLB, Plaud', PROMPT)).toBe(true);
  });

  it('обычная команда — не эхо', () => {
    expect(isPromptEcho('Поставь задачу на Азамата на завтра купить мясо', PROMPT)).toBe(false);
    expect(isPromptEcho('Создай встречу с IDAT завтра в 15:00', PROMPT)).toBe(false);
  });

  it('короткий ответ из одного-двух слов (имя) — не эхо', () => {
    expect(isPromptEcho('Азамат', PROMPT)).toBe(false);
    expect(isPromptEcho('Азамат Мухамедкаримов', PROMPT)).toBe(false);
  });

  it('пустой транскрипт или пустая подсказка — не эхо', () => {
    expect(isPromptEcho('', PROMPT)).toBe(false);
    expect(isPromptEcho('привет всем', '')).toBe(false);
  });
});

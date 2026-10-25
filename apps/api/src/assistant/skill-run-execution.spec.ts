import { parseRoute } from './assistant-router';
import { clipForTelegram, markdownToTelegramText } from './skill-run-execution.service';

describe('ответ навыка в Telegram', () => {
  it('markdown → простой текст', () => {
    expect(markdownToTelegramText('## Встречи\n- **10:00** — планёрка\n\n\n\nИтог')).toBe('ВСТРЕЧИ\n• 10:00 — планёрка\n\nИтог');
  });

  it('длинный текст обрезается по слову с пометкой', () => {
    const clipped = clipForTelegram('слово '.repeat(1000));
    expect(clipped.length).toBeLessThan(3900);
    expect(clipped).toContain('Полностью — в ассистенте Адъютанта.');
  });
});

describe('роутер', () => {
  it('неизвестный ответ — fast', () => {
    expect(parseRoute({ tier: 'deep', reason: 'анализ' })).toEqual({ tier: 'deep', reason: 'анализ' });
    expect(parseRoute({ tier: 'opus' })).toEqual({ tier: 'fast', reason: '' });
    expect(parseRoute(undefined).tier).toBe('fast');
  });
});

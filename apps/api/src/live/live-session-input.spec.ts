import { buildSessionInput, LIVE_INPUT_MAX_MESSAGES } from './live-session-input';

describe('buildSessionInput — session.input для GPT-Live', () => {
  it('сохраняет порядок и роли, user → input_text, assistant → output_text', () => {
    const result = buildSessionInput([
      { role: 'user', text: 'Мы обсуждали вчера IDAT.' },
      { role: 'assistant', text: 'Да, помню.' },
    ]);

    expect(result).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Мы обсуждали вчера IDAT.' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Да, помню.' }] },
    ]);
  });

  it('пустой разговор — пустой массив (вызывающий не передаёт поле input вовсе)', () => {
    expect(buildSessionInput([])).toEqual([]);
    expect(buildSessionInput([{ role: 'user', text: '   ' }])).toEqual([]);
  });

  it('берёт только последние сообщения, не всю историю', () => {
    const history = Array.from({ length: 50 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `m${i}` }));

    const result = buildSessionInput(history);

    expect(result).toHaveLength(LIVE_INPUT_MAX_MESSAGES);
    expect(result[result.length - 1].content[0].text).toBe('m49');
  });

  it('длинное сообщение обрезается, общий объём укладывается в бюджет (свежие важнее старых)', () => {
    const long = 'слово '.repeat(400); // 2400 символов
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, text: `${i} ${long}` }));

    const result = buildSessionInput(history);
    const total = result.reduce((sum, m) => sum + m.content[0].text.length, 0);

    expect(result.every((m) => m.content[0].text.length <= 801)).toBe(true);
    expect(total).toBeLessThanOrEqual(6000 + 10);
    expect(result[result.length - 1].content[0].text.startsWith('9 ')).toBe(true);
  });
});

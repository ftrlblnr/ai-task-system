import { buildSuggestUserContent, parseSuggestions, SUGGEST_INPUT_MAX_CHARS, SUGGEST_MAX_ITEMS } from './memory-suggest';

describe('parseSuggestions', () => {
  it('берёт корректные пункты и отбрасывает мусор', () => {
    const out = parseSuggestions(
      { items: [{ kind: 'PREFERENCE', text: '  Отчёты присылать   в xlsx ' }, { kind: 'HACK', text: 'x' }, { kind: 'FACT' }, 'строка', { kind: 'RULE', text: 'abc' }] },
      [],
    );
    expect(out).toEqual([{ kind: 'PREFERENCE', text: 'Отчёты присылать в xlsx' }]);
  });

  it('не предлагает то, что уже есть или было отклонено, и повторы внутри ответа', () => {
    const out = parseSuggestions(
      {
        items: [
          { kind: 'PREFERENCE', text: 'Отчёты присылать в xlsx' },
          { kind: 'PERSON', text: 'Жандос отвечает за поставки бетона' },
          { kind: 'PERSON', text: 'Жандос отвечает за поставки бетона на объект' },
        ],
      },
      ['отчеты присылай в XLSX'],
    );
    expect(out.map((o) => o.text)).toEqual(['Жандос отвечает за поставки бетона']);
  });

  it('не больше лимита и пустой ответ — пусто', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'FACT', text: `Уникальный факт номер ${i} про объект ${'абвгдежзик'[i]}` }));
    expect(parseSuggestions({ items: many }, []).length).toBeLessThanOrEqual(SUGGEST_MAX_ITEMS);
    expect(parseSuggestions(null, [])).toEqual([]);
  });
});

describe('buildSuggestUserContent', () => {
  it('режет самые старые реплики по бюджету и показывает известное', () => {
    const messages = Array.from({ length: 200 }, (_, i) => `реплика ${i} ${'x'.repeat(100)}`);
    const content = buildSuggestUserContent(messages, ['Отчёты в xlsx']);
    expect(content).toContain('- Отчёты в xlsx');
    expect(content).toContain('реплика 199');
    expect(content).not.toContain('реплика 0 ');
    expect(content.length).toBeLessThan(SUGGEST_INPUT_MAX_CHARS + 500);
  });
});

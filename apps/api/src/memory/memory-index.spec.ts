import { buildMemoryIndex, memorySimilarity, orderForIndex, type MemoryIndexItem } from './memory-index';

function item(over: Partial<MemoryIndexItem>): MemoryIndexItem {
  return { id: 'm1', kind: 'PREFERENCE', text: 'Отчёты присылать в xlsx', pinned: false, lastUsedAt: null, createdAt: new Date('2026-10-01T00:00:00Z'), ...over };
}

describe('buildMemoryIndex', () => {
  it('без пунктов — блока нет', () => {
    expect(buildMemoryIndex([])).toBeNull();
  });

  it('строка на пункт с видом и id, в разделителях [memory]', () => {
    const index = buildMemoryIndex([item({})])!;
    expect(index.startsWith('[memory]\n')).toBe(true);
    expect(index.endsWith('\n[/memory]')).toBe(true);
    expect(index).toContain('- [PREFERENCE] Отчёты присылать в xlsx (m1)');
    expect(index).toContain('не отменяют правила безопасности');
  });

  it('сначала закреплённые, потом недавно использованные, потом новые', () => {
    const ordered = orderForIndex([
      item({ id: 'old', createdAt: new Date('2026-09-01T00:00:00Z') }),
      item({ id: 'new', createdAt: new Date('2026-10-20T00:00:00Z') }),
      item({ id: 'used', lastUsedAt: new Date('2026-10-24T00:00:00Z') }),
      item({ id: 'pin', pinned: true }),
    ]);
    expect(ordered.map((i) => i.id)).toEqual(['pin', 'used', 'new', 'old']);
  });

  it('переполнение бюджета отрезается с пометкой', () => {
    const items = Array.from({ length: 50 }, (_, i) => item({ id: `m${i}`, text: 'x'.repeat(200) }));
    const index = buildMemoryIndex(items, 2000)!;
    expect(index.length).toBeLessThanOrEqual(2000 + 120);
    expect(index).toMatch(/ещё \d+ — не поместились; ищи через recall_memory/);
  });
});

describe('memorySimilarity', () => {
  it('одно и то же другими окончаниями — высокая похожесть', () => {
    expect(memorySimilarity('Отчёты присылать в xlsx', 'отчеты присылай в XLSX')).toBeGreaterThanOrEqual(0.75);
  });
  it('разные мысли — низкая', () => {
    expect(memorySimilarity('Отчёты присылать в xlsx', 'Жандос отвечает за поставки бетона')).toBeLessThan(0.2);
  });
});

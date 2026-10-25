import { NotFoundException } from '@nestjs/common';
import { AssistantToolsService, isWriteTool } from './assistant-tools.service';

// ARMS, фаза 1 — инструменты памяти: только руководству, remember с ключом
// идемпотентности вызова, чужой пункт — «не найден».
function makeService(memory: Record<string, jest.Mock>) {
  const prisma = { competency: { findMany: jest.fn().mockResolvedValue([]) } };
  const none = {} as never;
  return new AssistantToolsService(
    none, none, none, none, prisma as never, none, none, none, none,
    undefined, undefined, undefined, undefined, undefined,
    memory as never,
  );
}

const owner = { id: 'o1', email: 'o@x', role: 'OWNER' as const };
const employee = { id: 'e1', email: 'e@x', role: 'EMPLOYEE' as const };

describe('инструменты памяти', () => {
  it('видны руководству и не видны сотруднику', async () => {
    const service = makeService({});
    const names = (await service.buildTools(owner)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['remember', 'recall_memory', 'forget_memory']));
    expect((await service.buildTools(employee)).map((t) => t.name)).not.toContain('remember');
    const res = await service.execute('remember', { kind: 'FACT', text: 'x y z' }, employee, 'c1', 'm1', 0);
    expect(res).toMatchObject({ tool: 'remember', error: true });
  });

  it('remember и forget_memory — write-инструменты, ключ из userMessageId и индекса', async () => {
    expect(isWriteTool('remember')).toBe(true);
    expect(isWriteTool('forget_memory')).toBe(true);
    expect(isWriteTool('recall_memory')).toBe(false);
    const item = { id: 'm1', kind: 'PREFERENCE', text: 'Отчёты в xlsx' };
    const memory = { remember: jest.fn().mockResolvedValue({ item, duplicate: false, replaced: null, similar: [] }) };
    const service = makeService(memory);
    const res = await service.execute('remember', { kind: 'PREFERENCE', text: 'Отчёты в xlsx' }, owner, 'c1', 'msg1', 2);
    expect(memory.remember).toHaveBeenCalledWith('o1', { kind: 'PREFERENCE', text: 'Отчёты в xlsx', details: undefined, replacesId: undefined }, 'chat:msg1:2');
    expect(res).toEqual({ tool: 'remember', item: { id: 'm1', kind: 'PREFERENCE', text: 'Отчёты в xlsx' }, duplicate: false, replaced: null, similar: [] });
  });

  it('forget_memory чужого или несуществующего — безопасный отказ', async () => {
    const memory = { forget: jest.fn().mockRejectedValue(new NotFoundException()) };
    const res = await makeService(memory).execute('forget_memory', { id: 'чужой' }, owner, 'c1', 'msg1', 0);
    expect(res).toEqual({ tool: 'forget_memory', error: true, message: 'MEMORY_NOT_FOUND: такого пункта в памяти нет' });
  });
});

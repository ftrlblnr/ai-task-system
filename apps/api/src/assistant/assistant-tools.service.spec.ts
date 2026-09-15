import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantToolsService } from './assistant-tools.service';

// buildTools/execute не трогают реальный Anthropic — только RBAC-видимость
// инструментов и маппинг/каппинг реальных Task/Event в карточки (Stage 2
// Phase C, §16 — LLM не сочиняет данные карточек, только решает вызвать
// инструмент).
function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, isProfileAdmin: false, ...overrides };
}

describe('AssistantToolsService.buildTools (Stage 2 §16 — RBAC на уровне видимости инструмента, не постфактум)', () => {
  it('сотруднику предлагается только get_tasks — календарь закрыт на OWNER', () => {
    const service = new AssistantToolsService({} as any, {} as any);
    const names = service.buildTools(user()).map((t) => t.name);
    expect(names).toEqual(['get_tasks']);
  });

  it('руководителю предлагаются оба инструмента', () => {
    const service = new AssistantToolsService({} as any, {} as any);
    const names = service.buildTools(user({ role: Role.OWNER })).map((t) => t.name);
    expect(names).toEqual(['get_tasks', 'get_events']);
  });
});

describe('AssistantToolsService.execute get_tasks (Stage 2 §5.2/§16 — только реальные Task, не выдумка модели)', () => {
  const tasks = Array.from({ length: 15 }, (_, i) => ({
    id: `t${i}`,
    title: `Задача ${i}`,
    status: 'IN_PROGRESS',
    dueDate: null,
    assignee: null,
    isOverdue: i < 12, // первые 12 просрочены
  }));

  it('filter=all — все задачи, capped на 10, totalCount = реальное число', async () => {
    const tasksStub = { findAll: jest.fn().mockResolvedValue(tasks) };
    const service = new AssistantToolsService(tasksStub as any, {} as any);
    const result = await service.execute('get_tasks', { filter: 'all' }, user());
    expect(result).toMatchObject({ tool: 'get_tasks', totalCount: 15 });
    expect('items' in result && result.items).toHaveLength(10);
  });

  it('filter=overdue — фильтрует по isOverdue до каппинга (totalCount = 12, не 15)', async () => {
    const tasksStub = { findAll: jest.fn().mockResolvedValue(tasks) };
    const service = new AssistantToolsService(tasksStub as any, {} as any);
    const result = await service.execute('get_tasks', { filter: 'overdue' }, user());
    expect(result).toMatchObject({ tool: 'get_tasks', totalCount: 12 });
    expect('items' in result && result.items).toHaveLength(10);
  });

  it('сбой TasksService.findAll превращается в {error:true}, не бросает исключение наружу', async () => {
    const tasksStub = { findAll: jest.fn().mockRejectedValue(new Error('db down')) };
    const service = new AssistantToolsService(tasksStub as any, {} as any);
    const result = await service.execute('get_tasks', { filter: 'all' }, user());
    expect(result).toEqual({ tool: 'get_tasks', error: true, message: 'db down' });
  });
});

describe('AssistantToolsService.execute get_events (Stage 2 §5.3 — только предстоящие подтверждённые встречи)', () => {
  it('отфильтровывает отменённые и прошедшие встречи', async () => {
    const now = Date.now();
    const events = [
      { id: 'e1', title: 'Прошедшая', location: null, startAt: new Date(now - 1000), endAt: new Date(now), status: 'CONFIRMED', participants: [] },
      { id: 'e2', title: 'Отменённая', location: null, startAt: new Date(now + 1000), endAt: new Date(now + 2000), status: 'CANCELLED', participants: [] },
      { id: 'e3', title: 'Предстоящая', location: null, startAt: new Date(now + 3000), endAt: new Date(now + 4000), status: 'CONFIRMED', participants: [] },
    ];
    const eventsStub = { findAll: jest.fn().mockResolvedValue(events) };
    const service = new AssistantToolsService({} as any, eventsStub as any);
    const result = await service.execute('get_events', {}, user({ role: Role.OWNER }));
    expect(result).toMatchObject({ tool: 'get_events', totalCount: 1 });
    expect('items' in result && result.items[0].eventId).toBe('e3');
  });
});

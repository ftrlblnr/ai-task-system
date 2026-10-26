import { BadgesService } from './badges.service';

// Бейджи меню (W5) — на заглушках сервисов разделов.

function make(over: { mailbox?: (id?: string) => object | null; reception?: () => Promise<number> } = {}) {
  const tasks = { overdueCount: jest.fn().mockResolvedValue(3) };
  const reception = { waitingCount: jest.fn(over.reception ?? (() => Promise.resolve(2))) };
  const recommendations = { newCount: jest.fn().mockResolvedValue(4) };
  const store = { findOwnedMailbox: jest.fn((_owner: string, id?: string) => Promise.resolve(over.mailbox ? over.mailbox(id) : { id: 'mb1' })) };
  const triage = { summary: jest.fn().mockResolvedValue({ total: 7, needsReply: 5, top: [] }) };
  const service = new BadgesService(tasks as never, reception as never, recommendations as never, store as never, triage as never);
  return { service, store, triage, recommendations };
}

const owner = { id: 'owner-1', actingAsLeader: false };

describe('BadgesService', () => {
  it('руководство — все счётчики; почта — письма с тегом «Ответ» из разбора', async () => {
    const { service, triage, recommendations } = make();
    const res = await service.forUser({ id: 'owner-1', role: 'OWNER' } as never, owner, undefined);
    expect(res).toEqual({ tasksOverdue: 3, receptionWaiting: 2, mailNeedsReply: 5, recommendationsNew: 4 });
    expect(triage.summary).toHaveBeenCalledWith('mb1', 0);
    expect(recommendations.newCount).toHaveBeenCalledWith('owner-1');
  });

  it('сотрудник — только просрочка задач, остальное ему не положено', async () => {
    const { service, triage } = make();
    const res = await service.forUser({ id: 'e1', role: 'EMPLOYEE' } as never, { id: 'e1', actingAsLeader: false }, undefined);
    expect(res).toEqual({ tasksOverdue: 3, receptionWaiting: null, mailNeedsReply: null, recommendationsNew: null });
    expect(triage.summary).not.toHaveBeenCalled();
  });

  it('администратор в режиме руководителя — почта руководителя, рекомендации — свои', async () => {
    const { service, store, recommendations } = make();
    await service.forUser({ id: 'admin-1', role: 'ADMIN' } as never, { id: 'leader-1', actingAsLeader: true }, undefined);
    expect(store.findOwnedMailbox).toHaveBeenCalledWith('leader-1', undefined);
    expect(recommendations.newCount).toHaveBeenCalledWith('admin-1');
  });

  it('чужой сохранённый ящик — первый свой; почты нет — null', async () => {
    const fallback = make({ mailbox: (id) => (id ? null : { id: 'mb-own' }) });
    await fallback.service.forUser({ id: 'o', role: 'OWNER' } as never, owner, 'foreign');
    expect(fallback.triage.summary).toHaveBeenCalledWith('mb-own', 0);
    const none = make({ mailbox: () => null });
    expect((await none.service.forUser({ id: 'o', role: 'OWNER' } as never, owner, undefined)).mailNeedsReply).toBeNull();
  });

  it('упавший источник не ломает остальные бейджи', async () => {
    const { service } = make({ reception: () => Promise.reject(new Error('db')) });
    const res = await service.forUser({ id: 'o', role: 'OWNER' } as never, owner, undefined);
    expect(res.receptionWaiting).toBeNull();
    expect(res.tasksOverdue).toBe(3);
  });
});

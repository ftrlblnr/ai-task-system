import { BadRequestException, ConflictException } from '@nestjs/common';
import { compareTriage, draftBodyHash, nextWorkingMorning, buildReplyUserContent } from './mail-triage';
import { MailTriageService, triageDraftKey } from './mail-triage.service';
import { CreateTaskExecutor, SendReplyExecutor } from '../action/executors/triage-executors';

describe('nextWorkingMorning — «Позже» в разборе почты', () => {
  // Время задаётся в UTC; Алматы = UTC+5.
  it('в будний день — завтра 9:00 по Алматы (04:00 UTC)', () => {
    expect(nextWorkingMorning(new Date('2026-10-27T10:00:00Z')).toISOString()).toBe('2026-10-28T04:00:00.000Z');
  });
  it('в пятницу — понедельник', () => {
    expect(nextWorkingMorning(new Date('2026-10-30T10:00:00Z')).toISOString()).toBe('2026-11-02T04:00:00.000Z');
  });
  it('поздним вечером по UTC, когда в Алматы уже следующий день — считает от местной даты', () => {
    // 2026-10-27 20:00 UTC = 28.10 01:00 Алматы (среда) → четверг 29.10 9:00.
    expect(nextWorkingMorning(new Date('2026-10-27T20:00:00Z')).toISOString()).toBe('2026-10-29T04:00:00.000Z');
  });
});

describe('compareTriage', () => {
  it('сначала важность, затем кто дольше ждёт', () => {
    const rows = [
      { id: 'normal-old', importance: 'NORMAL' as const, receivedAt: new Date('2026-10-01') },
      { id: 'critical-new', importance: 'CRITICAL' as const, receivedAt: new Date('2026-10-20') },
      { id: 'normal-older', importance: 'NORMAL' as const, receivedAt: new Date('2026-09-30') },
    ];
    expect(rows.sort(compareTriage).map((r) => r.id)).toEqual(['critical-new', 'normal-older', 'normal-old']);
  });
});

describe('buildReplyUserContent', () => {
  it('письмо — внутри ограничителей, длинный текст обрезается', () => {
    const text = buildReplyUserContent({ ownerName: 'Жанна', subject: 'Счёт', fromName: null, fromAddress: 'a@b.kz', summary: null, actionSummary: null, textBody: 'x'.repeat(7000) });
    expect(text).toContain('<письмо>');
    expect(text).toContain('Отвечает: Жанна');
    expect(text.length).toBeLessThan(6300);
  });
});

describe('SendReplyExecutor', () => {
  const ctx = { mailboxId: 'mb1', ownerId: 'owner', session: {} as never };
  const item = (parameters: object) => ({ id: 'i1', parameters }) as never;

  function make(draft: object | null, send = jest.fn().mockResolvedValue({ ok: true, messageId: '<m>', rejected: [] })) {
    const prisma = { mailDraft: { findFirst: jest.fn().mockResolvedValue(draft) } };
    const store = { getMailbox: jest.fn().mockResolvedValue({ id: 'mb1' }) };
    const audit = { log: jest.fn() };
    return { executor: new SendReplyExecutor(prisma as never, store as never, { send } as never, audit as never), send, audit };
  }

  it('текст тот же, что согласован, — отправляет и пишет журнал', async () => {
    const { executor, send, audit } = make({ id: 'd1', state: 'DRAFT', body: 'Здравствуйте' });
    const res = await executor.execute(item({ draftId: 'd1', bodyHash: draftBodyHash('Здравствуйте') }), ctx);
    expect(res.outcome).toBe('SUCCEEDED');
    expect(send).toHaveBeenCalledWith({ id: 'mb1' }, 'd1');
    expect(audit.log).toHaveBeenCalledWith('owner', 'MAIL_SENT', 'MailDraft', 'd1', expect.objectContaining({ source: 'mail_triage' }));
  });

  it('черновик правили после согласия — не отправляет (SKIPPED_CHANGED)', async () => {
    const { executor, send } = make({ id: 'd1', state: 'DRAFT', body: 'Другой текст' });
    const res = await executor.execute(item({ draftId: 'd1', bodyHash: draftBodyHash('Здравствуйте') }), ctx);
    expect(res).toEqual({ outcome: 'SKIPPED_CHANGED', errorCode: 'DRAFT_CHANGED' });
    expect(send).not.toHaveBeenCalled();
  });

  it('сервер отправки отказал — FAILED с безопасным текстом', async () => {
    const { executor } = make({ id: 'd1', state: 'DRAFT', body: 'a' }, jest.fn().mockRejectedValue(new BadRequestException('Сервер отправки не отвечает')));
    const res = await executor.execute(item({ draftId: 'd1', bodyHash: draftBodyHash('a') }), ctx);
    expect(res).toMatchObject({ outcome: 'FAILED', errorCode: 'SEND_FAILED', providerResult: { message: 'Сервер отправки не отвечает' } });
  });

  it('уже отправлен — успех без повторной отправки', async () => {
    const { executor, send } = make({ id: 'd1', state: 'SENT', body: 'a' });
    expect((await executor.execute(item({ draftId: 'd1', bodyHash: 'x' }), ctx)).outcome).toBe('SUCCEEDED');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('CreateTaskExecutor', () => {
  it('ставит задачу от имени владельца плана', async () => {
    const prisma = { employee: { findUnique: jest.fn().mockResolvedValue({ id: 'owner', email: 'o@x.kz', role: 'OWNER' }) } };
    const tasks = { create: jest.fn().mockResolvedValue({ id: 't1' }) };
    const executor = new CreateTaskExecutor(prisma as never, tasks as never);
    const res = await executor.execute({ id: 'i1', parameters: { title: 'Подписать договор', assigneeId: 'e1', dueDate: null, description: 'Из письма' } } as never, {
      mailboxId: 'mb1',
      ownerId: 'owner',
      session: {} as never,
    });
    expect(res).toEqual({ outcome: 'SUCCEEDED', providerResult: { taskId: 't1' } });
    expect(tasks.create).toHaveBeenCalledWith(
      { title: 'Подписать договор', description: 'Из письма', assigneeId: 'e1', dueDate: undefined },
      { id: 'owner', email: 'o@x.kz', role: 'OWNER' },
    );
  });
});

describe('MailTriageService', () => {
  const mailbox = { id: 'mb1', employeeId: 'owner', displayName: null } as never;
  const message = { id: 'm1', uid: 7, subject: 'Счёт', fromName: 'ТОО Альфа', fromAddress: 'a@alpha.kz', folder: { path: 'INBOX', uidValidity: '5' }, analysis: { actionSummary: 'Оплатить' } };

  function make(over: { draft?: object | null; existingDraft?: object | null } = {}) {
    const prisma = {
      emailMessage: { findFirst: jest.fn().mockResolvedValue(message) },
      mailDraft: {
        findFirst: jest.fn().mockResolvedValue(over.draft === undefined ? { id: 'd1', state: 'DRAFT', body: 'Текст', toAddresses: ['a@alpha.kz'] } : over.draft),
        findUnique: jest.fn().mockResolvedValue(over.existingDraft ?? null),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      mailActionItem: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'item1', type: 'SEND_REPLY', parameters: {} }) },
      employee: { findFirst: jest.fn().mockResolvedValue({ id: 'e1' }), findUnique: jest.fn().mockResolvedValue({ fullName: 'Жанна' }) },
    };
    const plans = { createReadyPlan: jest.fn().mockResolvedValue({ id: 'p1', version: 1 }) };
    const compose = { get: jest.fn().mockResolvedValue({ id: 'd1' }), create: jest.fn().mockResolvedValue({ id: 'd2' }) };
    const service = new MailTriageService(prisma as never, {} as never, {} as never, compose as never, plans as never);
    return { service, prisma, plans, compose };
  }

  it('SEND_REPLY: правка текста сохраняется в черновик, в план — хэш именно этого текста', async () => {
    const { service, prisma, plans } = make();
    const res = await service.createAction('owner', mailbox, 'm1', { type: 'SEND_REPLY', draftId: 'd1', draftText: 'Исправленный' }, 'k1');
    expect(prisma.mailDraft.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ body: 'Исправленный' }) }));
    const [, , , candidates, sourceKey] = plans.createReadyPlan.mock.calls[0];
    expect(candidates[0]).toMatchObject({ type: 'SEND_REPLY', stableObjectIds: ['m1'], parameters: { draftId: 'd1', bodyHash: draftBodyHash('Исправленный') } });
    expect(sourceKey).toBe('triage:owner:k1');
    expect(res).toMatchObject({ planId: 'p1', planVersion: 1, itemId: 'item1', groupType: 'EXTERNAL_SEND' });
  });

  it('SEND_REPLY без текста или по уже отправленному черновику — отказ, план не создаётся', async () => {
    const empty = make({ draft: { id: 'd1', state: 'DRAFT', body: ' ', toAddresses: ['a@b.kz'] } });
    await expect(empty.service.createAction('owner', mailbox, 'm1', { type: 'SEND_REPLY', draftId: 'd1' }, 'k')).rejects.toBeInstanceOf(BadRequestException);
    const sent = make({ draft: { id: 'd1', state: 'SENT', body: 'a', toAddresses: ['a@b.kz'] } });
    await expect(sent.service.createAction('owner', mailbox, 'm1', { type: 'SEND_REPLY', draftId: 'd1' }, 'k')).rejects.toBeInstanceOf(ConflictException);
    expect(empty.plans.createReadyPlan).not.toHaveBeenCalled();
  });

  it('CREATE_TASK: описание со ссылкой на письмо, исполнитель проверяется', async () => {
    const { service, plans } = make();
    await service.createAction('owner', mailbox, 'm1', { type: 'CREATE_TASK', task: { title: ' Оплатить счёт ', assigneeId: 'e1' } }, 'k2');
    expect(plans.createReadyPlan.mock.calls[0][3][0].parameters).toEqual({
      title: 'Оплатить счёт',
      assigneeId: 'e1',
      dueDate: null,
      description: 'Из письма «Счёт» от ТОО Альфа <a@alpha.kz>.\nОплатить',
    });
  });

  it('черновик уже есть — возвращается без вызова модели', async () => {
    const { service, compose } = make({ existingDraft: { id: 'd1', mailboxId: 'mb1', state: 'DRAFT' } });
    await service.draftReply(mailbox, 'm1', false);
    expect(compose.get).toHaveBeenCalledWith('mb1', 'd1');
    expect(compose.create).not.toHaveBeenCalled();
  });

  it('пересоздать отправленный ответ нельзя', async () => {
    const { service } = make({ existingDraft: { id: 'd1', mailboxId: 'mb1', state: 'SENT' } });
    await expect(service.draftReply(mailbox, 'm1', true)).rejects.toBeInstanceOf(ConflictException);
  });

  it('отмена — удаляет только несогласованный план разбора своего ящика', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new MailTriageService({ mailActionPlan: { deleteMany } } as never, {} as never, {} as never, {} as never, {} as never);
    expect(await service.cancelAction('owner', 'mb1', 'p1')).toEqual({ cancelled: true });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: 'p1', ownerId: 'owner', mailboxId: 'mb1', sourceKey: { startsWith: 'triage:' }, approvals: { none: {} }, items: { every: { status: 'NEEDS_REVIEW' } } },
    });
  });

  it('ключ черновика — по письму', () => {
    expect(triageDraftKey('m1')).toBe('triage:m1');
  });
});

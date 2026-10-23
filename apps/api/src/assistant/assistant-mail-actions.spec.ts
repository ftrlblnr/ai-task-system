import { Role } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { buildMailPlanCandidates, parseMailToolActions, summarizeCandidates } from './assistant-mail-actions';
import { describePlanState } from './assistant-mail-state';
import { AssistantToolsService, toolResultForModel } from './assistant-tools.service';
import { buildAssistantParts } from './assistant-render';
import { serializeMessageForModelContext } from './assistant-chat.service';
import { stripLeakedContextMarkers } from './assistant-reply.service';

// Почта, этап 3 (23.10.2026): ассистент предлагает действия и готовит
// письма, исполнение — только кнопкой пользователя.

const folders = (...paths: string[]) => paths.map((path) => ({ path, role: path === 'INBOX' ? 'INBOX' : path === 'Архив-роль' ? 'ARCHIVE' : 'OTHER' }));
const msg = (id: string, mailboxId = 'mb1', uidValidity: string | null = '7') => ({ id, mailboxId, uid: 10, folder: { path: 'INBOX', uidValidity } });

describe('parseMailToolActions / buildMailPlanCandidates', () => {
  it('отбрасывает мусор от модели: без id, чужой тип', () => {
    const actions = parseMailToolActions([
      { emailId: 'e1', type: 'ARCHIVE', folderPath: null, reason: 'рассылка' },
      { emailId: '', type: 'ARCHIVE' },
      { emailId: 'e2', type: 'SEND_REPLY' },
      null,
    ]);
    expect(actions).toEqual([{ emailId: 'e1', type: 'ARCHIVE', folderPath: null, reason: 'рассылка' }]);
  });

  it('раскладывает по ящикам; чужие/несинхронизированные письма — в unknown; одно перемещение на письмо', () => {
    const actions = parseMailToolActions([
      { emailId: 'e1', type: 'ARCHIVE', folderPath: null, reason: '' },
      { emailId: 'e1', type: 'TRASH', folderPath: null, reason: '' },
      { emailId: 'e1', type: 'SET_READ', folderPath: null, reason: '' },
      { emailId: 'e2', type: 'MOVE', folderPath: 'Проекты', reason: 'по проекту' },
      { emailId: 'foreign', type: 'FLAG', folderPath: null, reason: '' },
      { emailId: 'nosync', type: 'FLAG', folderPath: null, reason: '' },
    ]);
    const draft = buildMailPlanCandidates(actions, [msg('e1'), msg('e2', 'mb2'), msg('nosync', 'mb1', null)], new Map([['mb1', folders('INBOX', 'Архив-роль')], ['mb2', folders('Проекты')]]));
    expect(draft.unknownEmailIds).toEqual(['foreign', 'nosync']);
    expect(draft.missingFolders).toEqual([]);
    expect(draft.byMailbox.get('mb1')!.map((c) => c.type)).toEqual(['ARCHIVE', 'SET_READ']);
    expect(draft.byMailbox.get('mb2')![0]).toMatchObject({ type: 'MOVE', parameters: { folderPath: 'Проекты' }, sourceLocators: { folderPath: 'INBOX', uidValidity: '7', uid: 10 }, relevance: 'RECOMMENDED' });
    expect(summarizeCandidates(draft.byMailbox.get('mb1')!)).toEqual([
      { type: 'ARCHIVE', count: 1 },
      { type: 'SET_READ', count: 1 },
    ]);
  });

  it('MOVE в несуществующую папку — не пункт, а missingFolders', () => {
    const draft = buildMailPlanCandidates(parseMailToolActions([{ emailId: 'e1', type: 'MOVE', folderPath: 'Нет такой', reason: '' }]), [msg('e1')], new Map([['mb1', folders('INBOX')]]));
    expect(draft.byMailbox.size).toBe(0);
    expect(draft.missingFolders).toEqual(['Нет такой']);
  });
});

describe('архив в ящике без папки \\Archive (инцидент 23.10.2026)', () => {
  it('ARCHIVE — одна строка без папки и без шага «создать папку»: архив находит/создаёт исполнитель', () => {
    const draft = buildMailPlanCandidates(parseMailToolActions([{ emailId: 'e1', type: 'ARCHIVE', folderPath: null, reason: '' }]), [msg('e1')], new Map([['mb1', folders('INBOX', 'Sent', 'Trash')]]));
    expect(draft.byMailbox.get('mb1')!.map((c) => [c.type, c.parameters])).toEqual([['ARCHIVE', {}]]);
  });

  it('describePlanState — живой статус карточки для модели', () => {
    const item = (status: string, selected = true, errorCode: string | null = null) => ({ planId: 'p', type: 'ARCHIVE', status: status as never, selected, errorCode });
    expect(describePlanState([item('NEEDS_REVIEW')])).toBe('awaiting_user_confirmation');
    expect(describePlanState([item('NEEDS_REVIEW', false)])).toBe('declined_by_user');
    expect(describePlanState([item('RUNNING')])).toBe('executing');
    expect(describePlanState([item('FAILED', true, 'ARCHIVE_FOLDER_MISSING')])).toBe('finished ARCHIVE:failed(ARCHIVE_FOLDER_MISSING)');
    expect(describePlanState([item('SUCCEEDED')])).toBe('finished ARCHIVE:done');
  });
});

describe('AssistantToolsService — почтовые пишущие инструменты', () => {
  const owner = { id: 'u1', email: 'o@x.kz', role: Role.OWNER };
  function setup(over: { messages?: unknown[]; folders?: string[]; draftCreate?: jest.Mock } = {}) {
    const prisma = {
      competency: { findMany: jest.fn().mockResolvedValue([]) },
      emailMessage: {
        findMany: jest.fn().mockResolvedValue(over.messages ?? [msg('e1')]),
        findFirst: jest.fn().mockResolvedValue({ mailboxId: 'mb1' }),
      },
    };
    const mailStore = {
      listMailboxesByEmployee: jest.fn().mockResolvedValue([{ id: 'mb1' }]),
      listFolders: jest.fn().mockResolvedValue((over.folders ?? ['INBOX', 'Archive']).map((path) => ({ path, role: 'OTHER' }))),
      findOwnedMailbox: jest.fn().mockResolvedValue({ id: 'mb1', emailAddress: 'boss@shark.kz' }),
      getMailbox: jest.fn().mockResolvedValue({ id: 'mb1', emailAddress: 'boss@shark.kz', employeeId: 'u1' }),
    };
    const plans = { createReadyPlan: jest.fn().mockResolvedValue({ id: 'plan1' }) };
    const compose = { create: over.draftCreate ?? jest.fn().mockResolvedValue({ id: 'd1', subject: 'Re: Смета', to: ['partner@x.kz'] }) };
    const audit = { log: jest.fn() };
    const service = new AssistantToolsService(
      {} as any, {} as any, {} as any, {} as any, prisma as any, audit as any, {} as any, mailStore as any, {} as any,
      undefined, undefined, undefined, plans as any, compose as any,
    );
    return { service, prisma, plans, compose, audit };
  }

  it('руководителю предлагаются propose_mail_actions и draft_mail_reply', async () => {
    const names = (await setup().service.buildTools(owner)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['propose_mail_actions', 'draft_mail_reply']));
  });

  it('сотруднику — нет', async () => {
    const names = (await setup().service.buildTools({ ...owner, role: Role.EMPLOYEE })).map((t) => t.name);
    expect(names).not.toContain('propose_mail_actions');
    expect(names).not.toContain('draft_mail_reply');
  });

  it('propose_mail_actions: создаёт план с ключом вызова, ничего не исполняет; модели — executed:false', async () => {
    const { service, plans } = setup();
    const result = await service.execute('propose_mail_actions', { request: 'Убери рассылки', actions: [{ emailId: 'e1', type: 'ARCHIVE', folderPath: null, reason: 'рассылка' }] }, owner, 'conv', 'msg1', 0);
    expect(plans.createReadyPlan).toHaveBeenCalledWith('u1', 'mb1', 'Убери рассылки', [expect.objectContaining({ type: 'ARCHIVE', stableObjectIds: ['e1'] })], 'chat:msg1:0:mb1');
    expect(result).toEqual({ tool: 'propose_mail_actions', plans: [{ planId: 'plan1', mailboxId: 'mb1', mailboxAddress: 'boss@shark.kz', actions: [{ type: 'ARCHIVE', count: 1 }], itemCount: 1 }], unknownEmailIds: [] });
    expect(toolResultForModel(result)).toMatchObject({ executed: false });
  });

  it('propose_mail_actions: папки нет — ошибка со списком папок, план не создаётся', async () => {
    const { service, plans } = setup();
    const result = await service.execute('propose_mail_actions', { request: 'x', actions: [{ emailId: 'e1', type: 'MOVE', folderPath: 'Проекты', reason: '' }] }, owner, 'conv', 'msg1', 0);
    expect(result).toMatchObject({ error: true, message: expect.stringContaining('INBOX, Archive') });
    expect(plans.createReadyPlan).not.toHaveBeenCalled();
  });

  it('propose_mail_actions: письма не из почты пользователя — EMAIL_NOT_FOUND', async () => {
    const { service } = setup({ messages: [] });
    const result = await service.execute('propose_mail_actions', { request: 'x', actions: [{ emailId: 'zzz', type: 'FLAG', folderPath: null, reason: '' }] }, owner, 'conv', 'msg1', 0);
    expect(result).toMatchObject({ error: true, message: expect.stringContaining('EMAIL_NOT_FOUND') });
  });

  it('draft_mail_reply: черновик с текстом и ключом; модели — sent:false', async () => {
    const { service, compose } = setup();
    const result = await service.execute('draft_mail_reply', { emailId: 'e1', mode: 'reply', body: 'Добрый день! Смету получили.' }, owner, 'conv', 'msg1', 1);
    expect(compose.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'mb1' }), 'REPLY', 'e1', { body: 'Добрый день! Смету получили.', to: undefined, sourceKey: 'chat:msg1:1' });
    expect(result).toEqual({ tool: 'draft_mail_reply', draft: { draftId: 'd1', mailboxId: 'mb1', mode: 'REPLY', subject: 'Re: Смета', to: ['partner@x.kz'] } });
    expect(toolResultForModel(result)).toMatchObject({ sent: false });
  });

  it('draft_mail_reply: пересылка без адресатов — просим уточнить, черновик не создаётся', async () => {
    const { service, compose } = setup();
    const result = await service.execute('draft_mail_reply', { emailId: 'e1', mode: 'forward', body: 'Посмотрите' }, owner, 'conv', 'msg1', 1);
    expect(result).toMatchObject({ error: true, message: expect.stringContaining('MISSING_RECIPIENTS') });
    expect(compose.create).not.toHaveBeenCalled();
  });

  it('draft_mail_reply: кривой адрес — понятная ошибка модели, не исключение', async () => {
    const { service } = setup({ draftCreate: jest.fn().mockRejectedValue(new BadRequestException('Кому: «abc» — не похоже на адрес почты')) });
    const result = await service.execute('draft_mail_reply', { emailId: 'e1', mode: 'forward', body: 'x', to: ['abc'] }, owner, 'conv', 'msg1', 1);
    expect(result).toMatchObject({ error: true, message: expect.stringContaining('не похоже на адрес') });
  });
});

describe('карточки почты в чате', () => {
  const plan = { planId: 'p1', mailboxId: 'mb1', mailboxAddress: 'boss@shark.kz', actions: [{ type: 'ARCHIVE', count: 3 }], itemCount: 3 };
  const draft = { draftId: 'd1', mailboxId: 'mb1', mode: 'REPLY' as const, subject: 'Re: Смета', to: ['a@x.kz'] };

  it('план и черновик становятся карточками после текста', () => {
    const parts = buildAssistantParts({
      text: 'Подготовил, подтвердите.',
      toolCalls: [
        { name: 'propose_mail_actions', input: {}, result: { tool: 'propose_mail_actions', plans: [plan], unknownEmailIds: [] } },
        { name: 'draft_mail_reply', input: {}, result: { tool: 'draft_mail_reply', draft } },
      ],
    } as any);
    expect(parts.map((p) => p.type)).toEqual(['TOOL_ACTIVITY', 'TOOL_ACTIVITY', 'MARKDOWN', 'MAIL_PLAN_CARD', 'MAIL_DRAFT_CARD']);
    expect(parts[0].data).toEqual({ label: 'Подготовил действия с письмами: 3 — ждут подтверждения' });
  });

  it('в истории для модели — служебная пометка, которая не утекает в ответ', () => {
    const text = serializeMessageForModelContext([
      { type: 'MAIL_PLAN_CARD', data: plan },
      { type: 'MAIL_DRAFT_CARD', data: draft },
    ] as any);
    expect(text).toContain('[shown_mail_plan]\nid=p1');
    expect(text).toContain('status=awaiting_user_send');
    expect(stripLeakedContextMarkers(`Готово.\n${text}`)).toBe('Готово.');
  });
  it('живой статус из БД подставляется в пометку (перенос упал / письмо отправлено)', () => {
    const text = serializeMessageForModelContext(
      [
        { type: 'MAIL_PLAN_CARD', data: plan },
        { type: 'MAIL_DRAFT_CARD', data: draft },
      ] as any,
      { plans: new Map([['p1', 'finished ARCHIVE:failed(ARCHIVE_FOLDER_MISSING)']]), drafts: new Map([[draft.draftId, 'sent']]) },
    );
    expect(text).toContain('status=finished ARCHIVE:failed(ARCHIVE_FOLDER_MISSING)');
    expect(text).toContain('status=sent');
  });
});

import { MessageRole, Prisma, Role, VoiceExecutionStatus } from '@prisma/client';
import { VoiceService } from './voice.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { VoiceEventActionDraft, VoiceTaskActionDraft } from './dto/voice-draft-response.dto';

function p2002(message = 'Unique constraint failed'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code: 'P2002', clientVersion: '6.19.3' });
}

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, isProfileAdmin: false, ...overrides };
}

// Ни validateTarget, ни validateEventCreateCompleteness, ни
// validateReferences, ни enforceEventRbac не трогают внедрённые зависимости
// (whisper/extraction/prisma/audit/tasks/events) — заглушены, тестируем
// саму логику (аудит 10.09.2026, п. 5.1).
function makeService(): any {
  return new VoiceService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
}

function taskDraft(overrides: Partial<VoiceTaskActionDraft> = {}): VoiceTaskActionDraft {
  return {
    type: 'task_action',
    action: 'update',
    targetTaskId: 't1',
    targetTitle: 'Задача',
    title: '',
    description: '',
    assigneeId: null,
    assigneeName: null,
    assigneeMentioned: false,
    assigneeRawText: '',
    dueDate: null,
    priority: null,
    sourceMeetingId: null,
    ...overrides,
  };
}

function eventDraft(overrides: Partial<VoiceEventActionDraft> = {}): VoiceEventActionDraft {
  return {
    type: 'event_action',
    action: 'create',
    targetEventId: '',
    targetTitle: 'Встреча',
    title: 'Встреча',
    description: '',
    location: '',
    startAt: '2026-09-15T15:00:00+05:00',
    endAt: null,
    allDay: null,
    addParticipantIds: [],
    addParticipantNames: [],
    removeParticipantIds: [],
    removeParticipantNames: [],
    ...overrides,
  };
}

describe('VoiceService.validateTarget (закрытый список id вместо enum в схеме, см. draft-extraction.service.ts)', () => {
  const service = makeService();

  it('task_action update/delete с неизвестным targetTaskId превращается в chat-уточнение', () => {
    const result = service.validateTarget(taskDraft({ action: 'delete', targetTaskId: 'unknown' }), new Set(['t1']), new Set());
    expect(result.type).toBe('chat');
  });

  it('task_action update/delete с известным targetTaskId проходит без изменений', () => {
    const draft = taskDraft({ action: 'update', targetTaskId: 't1' });
    const result = service.validateTarget(draft, new Set(['t1']), new Set());
    expect(result).toBe(draft);
  });

  it('task_action create не проверяется (targetTaskId у него пустой по определению)', () => {
    const draft = taskDraft({ action: 'create', targetTaskId: '' });
    const result = service.validateTarget(draft, new Set(), new Set());
    expect(result).toBe(draft);
  });

  it('event_action update/delete с неизвестным targetEventId превращается в chat-уточнение', () => {
    const result = service.validateTarget(
      eventDraft({ action: 'update', targetEventId: 'unknown' }),
      new Set(),
      new Set(['e1']),
    );
    expect(result.type).toBe('chat');
  });
});

describe('VoiceService.validateEventCreateCompleteness (владелец 10.09.2026 — startAt обязателен на create)', () => {
  const service = makeService();

  it('event_action create без startAt превращается в chat-уточнение, а не создаёт битое событие', () => {
    const result = service.validateEventCreateCompleteness(eventDraft({ startAt: null }));
    expect(result.type).toBe('chat');
  });

  it('event_action create со startAt проходит без изменений', () => {
    const draft = eventDraft({ startAt: '2026-09-15T15:00:00+05:00' });
    const result = service.validateEventCreateCompleteness(draft);
    expect(result).toBe(draft);
  });

  it('event_action update без startAt НЕ трогается (startAt=null для update значит "не упомянуто", не ошибка)', () => {
    const draft = eventDraft({ action: 'update', startAt: null });
    const result = service.validateEventCreateCompleteness(draft);
    expect(result).toBe(draft);
  });
});

describe('VoiceService.validateReferences (fail-safe в null/отфильтрованный список, не в ошибку)', () => {
  const service = makeService();
  const knownEmployees = new Set(['emp1', 'emp2']);

  it('невалидный assigneeId у task_action превращается в null', () => {
    const result = service.validateReferences(taskDraft({ assigneeId: 'ghost' }), knownEmployees);
    expect(result.assigneeId).toBeNull();
  });

  it('валидный assigneeId остаётся как есть', () => {
    const result = service.validateReferences(taskDraft({ assigneeId: 'emp1' }), knownEmployees);
    expect(result.assigneeId).toBe('emp1');
  });

  it('невалидные id участников события отфильтровываются, валидные остаются', () => {
    const result = service.validateReferences(
      eventDraft({ addParticipantIds: ['emp1', 'ghost'], removeParticipantIds: ['ghost'] }),
      knownEmployees,
    );
    expect(result.addParticipantIds).toEqual(['emp1']);
    expect(result.removeParticipantIds).toEqual([]);
  });
});

// Stage 2, Phase I (внешний аудит 21.09.2026, "Employee Resolver") —
// независимая от модели перепроверка assigneeId.
describe('VoiceService.resolveAssigneeMention', () => {
  function serviceWithResolver(resolve: jest.Mock) {
    const employeeResolver = { resolve };
    return new VoiceService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, employeeResolver as any) as any;
  }

  it('assigneeMentioned=false — резолвер не вызывается, черновик не меняется', async () => {
    const resolve = jest.fn();
    const service = serviceWithResolver(resolve);
    const draft = taskDraft({ assigneeMentioned: false, assigneeRawText: '' });

    const result = await service.resolveAssigneeMention(draft, []);

    expect(resolve).not.toHaveBeenCalled();
    expect(result).toBe(draft);
  });

  it('не task_action — не трогается', async () => {
    const resolve = jest.fn();
    const service = serviceWithResolver(resolve);
    const draft = eventDraft();

    const result = await service.resolveAssigneeMention(draft, []);

    expect(resolve).not.toHaveBeenCalled();
    expect(result).toBe(draft);
  });

  it('RESOLVED — переопределяет assigneeId результатом резолвера, а не оставляет догадку модели', async () => {
    const resolve = jest.fn().mockResolvedValue({ status: 'RESOLVED', employeeId: 'emp-real' });
    const service = serviceWithResolver(resolve);
    const employees = [{ id: 'emp-real', fullName: 'Амир Жаксылыков' }];
    const draft = taskDraft({ assigneeMentioned: true, assigneeRawText: 'Амиру', assigneeId: null });

    const result = await service.resolveAssigneeMention(draft, employees);

    expect(resolve).toHaveBeenCalledWith('Амиру', employees);
    expect(result.assigneeId).toBe('emp-real');
    expect(result.type).toBe('task_action');
  });

  it('AMBIGUOUS — превращается в chat-уточнение вместо unassigned-задачи', async () => {
    const resolve = jest.fn().mockResolvedValue({ status: 'AMBIGUOUS', employeeId: null });
    const service = serviceWithResolver(resolve);
    const draft = taskDraft({ assigneeMentioned: true, assigneeRawText: 'Алексею' });

    const result = await service.resolveAssigneeMention(draft, []);

    expect(result.type).toBe('chat');
    expect(result.reply).toContain('Алексею');
  });

  it('NOT_FOUND — превращается в chat-уточнение, не создаёт задачу без исполнителя молча', async () => {
    const resolve = jest.fn().mockResolvedValue({ status: 'NOT_FOUND', employeeId: null });
    const service = serviceWithResolver(resolve);
    const draft = taskDraft({ assigneeMentioned: true, assigneeRawText: 'Марине Сергеевне' });

    const result = await service.resolveAssigneeMention(draft, []);

    expect(result.type).toBe('chat');
    expect(result.reply).toContain('Не нашёл');
  });
});

describe('VoiceService.enforceEventRbac (граница безопасности — не полагается на промпт, см. комментарий в самом коде)', () => {
  const service = makeService();

  it('руководителю событие не трогает — возвращает массив из одного элемента без изменений', () => {
    const draft = eventDraft();
    const result = service.enforceEventRbac(draft, Role.OWNER);
    expect(result).toEqual([draft]);
  });

  it('не-руководителю event_action create разворачивается в [задача, chat-объяснение]', () => {
    const result = service.enforceEventRbac(eventDraft({ title: 'Встреча по проекту' }), Role.EMPLOYEE);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('task_action');
    expect(result[0].action).toBe('create');
    expect(result[0].title).toBe('Встреча по проекту');
    expect(result[1].type).toBe('chat');
  });

  it('не-руководителю event_action update/delete превращается в отказ (chat), календарь ему недоступен', () => {
    const result = service.enforceEventRbac(eventDraft({ action: 'update' }), Role.EMPLOYEE);
    expect(result).toEqual([{ type: 'chat', reply: expect.stringContaining('руководителю') }]);
  });

  it('task_action не трогается независимо от роли', () => {
    const draft = taskDraft();
    expect(service.enforceEventRbac(draft, Role.EMPLOYEE)).toEqual([draft]);
  });
});

// Stage 2, Phase H.4 (внешний аудит 21.09.2026, "trusted server-side
// undo") — executeTaskAction/executeEventAction создают UndoRecord через
// prisma.undoRecord.create сразу после мутации (create/update), поэтому
// эти тесты нужен мок этой таблицы; delete/ошибка undoToken не создают.
function undoRecordPrismaMock(id = 'undo-1') {
  return { undoRecord: { create: jest.fn().mockResolvedValue({ id }) } };
}

describe('VoiceService.executeTaskAction (Stage 2, Phase H — entity для карточки объединённой ленты)', () => {
  it('create — entity берётся из возврата TasksService.create напрямую, undoToken из UndoRecord', async () => {
    const created = { id: 't1', title: 'Задача', status: 'NEW', dueDate: null, assignee: null };
    const tasks = { create: jest.fn().mockResolvedValue(created) };
    const prisma = undoRecordPrismaMock();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, {} as any, {} as any) as any;
    const draft = taskDraft({ action: 'create' });

    const { result, entity } = await service.executeTaskAction(draft, makeUser());

    expect(result).toEqual({ type: 'task_action', draft, ok: true, error: null, taskId: 't1', undoToken: 'undo-1' });
    expect(entity).toBe(created);
    expect(prisma.undoRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ employeeId: 'u1', kind: 'TASK', action: 'CREATE', entityId: 't1' }) }),
    );
  });

  it('update — entity берётся из свежего возврата TasksService.update, не из before-снимка; UndoRecord несёт previous', async () => {
    const before = { id: 't1', title: 'Старое', description: '', assignee: null, dueDate: null, priority: null };
    const updated = { id: 't1', title: 'Новое', status: 'NEW', dueDate: null, assignee: null };
    const tasks = { findOne: jest.fn().mockResolvedValue(before), update: jest.fn().mockResolvedValue(updated) };
    const prisma = undoRecordPrismaMock();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, {} as any, {} as any) as any;
    const draft = taskDraft({ action: 'update', targetTaskId: 't1', title: 'Новое' });

    const { entity, result } = await service.executeTaskAction(draft, makeUser());

    expect(entity).toBe(updated);
    expect(result.undoToken).toBe('undo-1');
    expect(prisma.undoRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'TASK', action: 'UPDATE', entityId: 't1', previous: { title: 'Старое' } }) }),
    );
  });

  it('delete — entity=null, сущности больше нет, undoToken=null (нет UndoRecord)', async () => {
    const tasks = { remove: jest.fn().mockResolvedValue(undefined) };
    const service = new VoiceService({} as any, {} as any, {} as any, {} as any, tasks as any, {} as any, {} as any) as any;
    const draft = taskDraft({ action: 'delete', targetTaskId: 't1' });

    const { result, entity } = await service.executeTaskAction(draft, makeUser());

    expect(entity).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.undoToken).toBeNull();
  });

  it('ошибка — entity=null, ok=false, undoToken=null, тот же текст исключения, что раньше уходил клиенту напрямую', async () => {
    const tasks = { create: jest.fn().mockRejectedValue(new Error('Постановщик не найден')) };
    const service = new VoiceService({} as any, {} as any, {} as any, {} as any, tasks as any, {} as any, {} as any) as any;
    const draft = taskDraft({ action: 'create' });

    const { result, entity } = await service.executeTaskAction(draft, makeUser());

    expect(entity).toBeNull();
    expect(result).toMatchObject({ ok: false, error: 'Постановщик не найден', undoToken: null });
  });
});

describe('VoiceService.executeEventAction (Stage 2, Phase H — entity для карточки, включая участников)', () => {
  it('create без участников — entity это created напрямую, без лишнего findOne', async () => {
    const created = { id: 'e1', title: 'Встреча', startAt: new Date(), endAt: new Date(), location: null, participants: [] };
    const events = { create: jest.fn().mockResolvedValue(created), findOne: jest.fn() };
    const prisma = undoRecordPrismaMock();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, events as any, {} as any) as any;
    const draft = eventDraft({ action: 'create', addParticipantIds: [] });

    const { entity, result } = await service.executeEventAction(draft, makeUser({ role: Role.OWNER }));

    expect(entity).toBe(created);
    expect(events.findOne).not.toHaveBeenCalled();
    expect(result.undoToken).toBe('undo-1');
  });

  it('create с участниками — entity дозапрашивается через findOne ПОСЛЕ addParticipant (у created ещё нет свежих участников)', async () => {
    const created = { id: 'e1', title: 'Встреча', startAt: new Date(), endAt: new Date(), location: null, participants: [] };
    const refetched = { ...created, participants: [{ id: 'emp1', fullName: 'Азамат' }] };
    const events = {
      create: jest.fn().mockResolvedValue(created),
      addParticipant: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(refetched),
    };
    const prisma = undoRecordPrismaMock();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, events as any, {} as any) as any;
    const draft = eventDraft({ action: 'create', addParticipantIds: ['emp1'] });

    const { entity } = await service.executeEventAction(draft, makeUser({ role: Role.OWNER }));

    expect(events.addParticipant).toHaveBeenCalledWith('e1', 'emp1');
    expect(events.findOne).toHaveBeenCalledWith('e1');
    expect(entity).toBe(refetched);
  });

  it('update — entity это финальный findOne после изменения полей и участников, не before-снимок; UndoRecord несёт участников', async () => {
    const before = { id: 'e1', title: 'Старое', description: '', location: '', startAt: new Date('2026-01-01T00:00:00Z'), endAt: new Date('2026-01-01T01:00:00Z'), allDay: false };
    const finalEntity = { id: 'e1', title: 'Новое', startAt: before.startAt, endAt: before.endAt, location: null, participants: [] };
    const events = {
      findOne: jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(finalEntity),
      update: jest.fn().mockResolvedValue(undefined),
      addParticipant: jest.fn().mockResolvedValue(undefined),
      removeParticipant: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = undoRecordPrismaMock();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, events as any, {} as any) as any;
    const draft = eventDraft({ action: 'update', targetEventId: 'e1', title: 'Новое', addParticipantIds: ['emp1'], removeParticipantIds: ['emp2'] });

    const { entity } = await service.executeEventAction(draft, makeUser({ role: Role.OWNER }));

    expect(entity).toBe(finalEntity);
    expect(events.findOne).toHaveBeenCalledTimes(2);
    expect(prisma.undoRecord.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ addedParticipantIds: ['emp1'], removedParticipantIds: ['emp2'] }),
      }),
    );
  });
});

describe('VoiceService.logAssistantMessage (Stage 2, Phase H — standalone-сообщение в общей ленте, не отдельная VoiceMessage)', () => {
  it('пишет ASSISTANT-сообщение без replyToMessageId в разговор от getOrCreatePrimaryConversation', async () => {
    const conversation = { id: 'c1' };
    const assistantChat = { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue(conversation) };
    const prisma = { message: { create: jest.fn().mockResolvedValue({}) } };
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, {} as any, assistantChat as any) as any;

    await service.logAssistantMessage('Отменено.', makeUser());

    expect(assistantChat.getOrCreatePrimaryConversation).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }));
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: {
        conversationId: 'c1',
        role: MessageRole.ASSISTANT,
        status: 'COMPLETED',
        parts: { create: [{ type: 'MARKDOWN', order: 0, data: { content: 'Отменено.' } }] },
      },
    });
  });
});

describe('VoiceService.loadHistory (Stage 2, Phase H — читает Message/MessagePart вместо отдельной VoiceMessage)', () => {
  it('фильтрует по conversationId и окну VOICE_HISTORY_MAX_AGE_MS, сериализует части через общий serializeMessageForModelContext', async () => {
    const rows = [
      { role: MessageRole.ASSISTANT, parts: [{ type: 'MARKDOWN', order: 0, data: { content: 'Привет!' } }] },
      { role: MessageRole.USER, parts: [{ type: 'MARKDOWN', order: 0, data: { content: 'Перенеси на вторник' } }] },
    ];
    const prisma = { message: { findMany: jest.fn().mockResolvedValue(rows) } };
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, {} as any, {} as any) as any;

    const history = await service.loadHistory('c1');

    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ conversationId: 'c1' }) }),
    );
    // rows приходят DESC (order: 'desc' в запросе) — loadHistory разворачивает
    // их обратно в хронологический порядок, тот же приём, что уже в
    // AssistantChatService.loadHistory.
    expect(history).toEqual([
      { role: 'user', text: 'Перенеси на вторник' },
      { role: 'assistant', text: 'Привет!' },
    ]);
  });
});

// Stage 2, Phase H.1 (внешний аудит 20.09.2026, P0/P1) — заменяет прежний
// POST /voice/messages (клиент мог записать в общую ленту произвольный
// текст с ролью ASSISTANT). undo() выполняет откат сам, теми же
// TasksService/EventsService, что и executeTaskAction/executeEventAction
// — тестируем и сам откат, и то, что текст подтверждения решает сервер
// (logAssistantMessage вызывается с фиксированным/безопасным текстом, не
// с чем-то, что мог бы продиктовать клиент).
// Stage 2, Phase H.4 (внешний аудит 21.09.2026, "trusted server-side
// undo") — dto теперь только { undoToken }, все данные для отката читаются
// из хранимой UndoRecord, не из того, что прислал клиент.
describe('VoiceService.undo (Stage 2, Phase H.1 → H.4)', () => {
  function makeAssistantChat(conversationId = 'c1') {
    return { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: conversationId }) };
  }

  function undoRecord(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'undo-1',
      employeeId: 'u1',
      kind: 'TASK',
      action: 'CREATE',
      entityId: 't1',
      previous: null,
      addedParticipantIds: null,
      removedParticipantIds: null,
      expiresAt: new Date(Date.now() + 30_000),
      consumedAt: null,
      ...overrides,
    };
  }

  function undoPrisma(record: ReturnType<typeof undoRecord> | null, messageCreate = jest.fn().mockResolvedValue({})) {
    return {
      undoRecord: {
        findUnique: jest.fn().mockResolvedValue(record),
        update: jest.fn().mockResolvedValue(record ? { ...record, consumedAt: new Date() } : null),
      },
      message: { create: messageCreate },
    };
  }

  it('task create — откатывает через tasks.remove, пишет "Отменено.", помечает UndoRecord потреблённой', async () => {
    const record = undoRecord();
    const tasks = { remove: jest.fn().mockResolvedValue(undefined) };
    const prisma = undoPrisma(record);
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, {} as any, assistantChat as any) as any;

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(tasks.remove).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'u1' }));
    expect(result).toEqual({ ok: true, error: null });
    expect(prisma.undoRecord.update).toHaveBeenCalledWith({ where: { id: 'undo-1', consumedAt: null }, data: { consumedAt: expect.any(Date) } });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ parts: { create: [{ type: 'MARKDOWN', order: 0, data: { content: 'Отменено.' } }] } }) }),
    );
  });

  it('task update — собирает патч из previous поштучно, не спредом (лишние поля previous не всплывают в вызове)', async () => {
    const previous = { title: 'Старое название', assigneeId: null, unexpectedField: 'should be ignored' };
    const record = undoRecord({ action: 'UPDATE', previous });
    const tasks = { update: jest.fn().mockResolvedValue({}) };
    const prisma = undoPrisma(record);
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, {} as any, assistantChat as any) as any;

    await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(tasks.update).toHaveBeenCalledWith('t1', { title: 'Старое название', assigneeId: null }, expect.objectContaining({ id: 'u1' }));
  });

  it('не найдено / не своя / уже отменена / истекла — общий безопасный текст, TasksService/EventsService не трогаются', async () => {
    const tasks = { remove: jest.fn() };
    const events = { remove: jest.fn() };
    const assistantChat = makeAssistantChat();

    // не найдено
    let prisma = undoPrisma(null);
    let service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, events as any, assistantChat as any) as any;
    let result = await service.undo({ undoToken: 'missing' }, makeUser());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('истекло');

    // чужая (employeeId не совпадает)
    prisma = undoPrisma(undoRecord({ employeeId: 'someone-else' }));
    service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, events as any, assistantChat as any) as any;
    result = await service.undo({ undoToken: 'undo-1' }, makeUser());
    expect(result.ok).toBe(false);

    // уже отменена
    prisma = undoPrisma(undoRecord({ consumedAt: new Date() }));
    service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, events as any, assistantChat as any) as any;
    result = await service.undo({ undoToken: 'undo-1' }, makeUser());
    expect(result.ok).toBe(false);

    // истекла
    prisma = undoPrisma(undoRecord({ expiresAt: new Date(Date.now() - 1000) }));
    service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, events as any, assistantChat as any) as any;
    result = await service.undo({ undoToken: 'undo-1' }, makeUser());
    expect(result.ok).toBe(false);

    expect(tasks.remove).not.toHaveBeenCalled();
    expect(events.remove).not.toHaveBeenCalled();
  });

  it('event create — не-OWNER получает отказ ДО вызова events.remove (защитная RBAC-проверка)', async () => {
    const record = undoRecord({ kind: 'EVENT', entityId: 'e1' });
    const events = { remove: jest.fn() };
    const prisma = undoPrisma(record);
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, events as any, assistantChat as any) as any;

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser({ role: Role.EMPLOYEE }));

    expect(events.remove).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('руководителю');
  });

  it('event update — инвертирует участников (добавленные снимает, снятые возвращает)', async () => {
    const record = undoRecord({
      kind: 'EVENT',
      action: 'UPDATE',
      entityId: 'e1',
      previous: {},
      addedParticipantIds: ['emp1'],
      removedParticipantIds: ['emp2'],
    });
    const events = {
      update: jest.fn().mockResolvedValue({}),
      addParticipant: jest.fn().mockResolvedValue(undefined),
      removeParticipant: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = undoPrisma(record);
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, events as any, assistantChat as any) as any;

    await service.undo({ undoToken: 'undo-1' }, makeUser({ role: Role.OWNER }));

    expect(events.removeParticipant).toHaveBeenCalledWith('e1', 'emp1');
    expect(events.addParticipant).toHaveBeenCalledWith('e1', 'emp2');
    expect(events.update).not.toHaveBeenCalled(); // previous пуст — нечего обновлять полями
  });

  it('ошибка отката — ok=false, безопасный текст (toErrorMessage), тоже логируется', async () => {
    const record = undoRecord();
    const tasks = { remove: jest.fn().mockRejectedValue(new Error('Удалить задачу может только её постановщик или руководитель')) };
    const prisma = undoPrisma(record);
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, {} as any, assistantChat as any) as any;

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(result).toEqual({ ok: false, error: 'Удалить задачу может только её постановщик или руководитель' });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parts: { create: [{ type: 'MARKDOWN', order: 0, data: { content: 'Не получилось отменить: Удалить задачу может только её постановщик или руководитель' } }] },
        }),
      }),
    );
  });

  // Гонка двойного одновременного POST /voice/undo с одним undoToken —
  // атомарный claim (update where: {id, consumedAt: null}) должен закрыть
  // её: проверяем через прямой сбой этого update как P2025 (Prisma
  // возвращает его, когда where не matches ни одной строки — тот же
  // сценарий, что случился бы у второго конкурентного запроса).
  it('гонка двойного undo — P2025 на claim-update трактуется как "уже отменено", tasks.remove НЕ вызывается', async () => {
    const record = undoRecord();
    const tasks = { remove: jest.fn() };
    const prisma = {
      undoRecord: {
        findUnique: jest.fn().mockResolvedValue(record),
        update: jest.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: '6.19.3' })),
      },
      message: { create: jest.fn().mockResolvedValue({}) },
    };
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, {} as any, assistantChat as any) as any;

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(result.ok).toBe(false);
    expect(tasks.remove).not.toHaveBeenCalled();
  });
});

// Stage 2, Phase H.3 (внешний аудит 21.09.2026, P0 — "durable voice
// exactly-once") — заменяет старый findCachedParseResponse (Phase H.1),
// который смотрел на Message-строки (побочный эффект персистентности) и
// не мог отличить "действие не выполнялось" от "действие выполнилось, но
// история переписки не сохранилась" — единственный безопасный выход тогда
// был удалить незавершённую строку и выполнить ВСЁ заново, включая уже
// случившуюся бизнес-мутацию (ровно то, на что указал аудит). VoiceExecution
// — durable claim именно о жизненном цикле выполнения, не о персистентности.
function baseParseMocks() {
  const whisperSpy = jest.fn().mockResolvedValue({ text: 'Привет', durationMs: 500 });
  const extractSpy = jest.fn().mockResolvedValue({
    drafts: [{ type: 'chat', reply: 'Ок' }],
    confidence: 'HIGH',
    clarificationNeeded: false,
    clarificationReason: 'null',
    timing: { fastMs: 10, strongMs: 0 },
    escalatedToStrongModel: false,
  });
  return { whisperSpy, extractSpy };
}

describe('VoiceService.parse — durable exactly-once (Stage 2, Phase H.3, P0)', () => {
  it('COMPLETED — возвращает реальный сохранённый results (не пустышку), Whisper/Claude не вызываются повторно', async () => {
    const cachedUserMessage = { id: 'm1', conversationId: 'c1', role: MessageRole.USER, status: 'COMPLETED', clientRequestId: 'req-1', createdAt: new Date(), updatedAt: new Date(), parts: [] };
    const cachedAssistantMessage = { id: 'm2', conversationId: 'c1', role: MessageRole.ASSISTANT, status: 'COMPLETED', clientRequestId: null, createdAt: new Date(), updatedAt: new Date(), parts: [] };
    const { whisperSpy, extractSpy } = baseParseMocks();
    const assistantChat = { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'c1' }) };
    const prisma = {
      voiceExecution: {
        create: jest.fn().mockRejectedValue(p2002()),
        findUnique: jest.fn().mockResolvedValue({
          id: 'exec-1',
          conversationId: 'c1',
          status: VoiceExecutionStatus.COMPLETED,
          userMessageId: 'm1',
          assistantMessageId: 'm2',
          resultJson: {
            transcript: 'Создай задачу купить билеты',
            confidence: 'HIGH',
            clarificationNeeded: false,
            clarificationReason: null,
            results: [{ type: 'task_action', draft: {}, ok: true, error: null, taskId: 't1', previous: null }],
          },
        }),
      },
      message: {
        findUnique: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.id === 'm1' ? cachedUserMessage : cachedAssistantMessage)),
      },
    };
    const service = new VoiceService({ transcribe: whisperSpy } as any, { extract: extractSpy } as any, prisma as any, {} as any, {} as any, {} as any, assistantChat as any);
    const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' } as any;

    const response = await service.parse(audio, makeUser(), undefined, 'req-1');

    expect(whisperSpy).not.toHaveBeenCalled();
    expect(extractSpy).not.toHaveBeenCalled();
    expect(response.results).toEqual([{ type: 'task_action', draft: {}, ok: true, error: null, taskId: 't1', previous: null }]);
    expect(response.userMessage?.id).toBe('m1');
    expect(response.assistantMessage?.id).toBe('m2');
  });

  it('FAILED — ничего ещё не выполнялось, retry безопасен и реально запускает Whisper/Claude заново', async () => {
    const userMessage = { id: 'm1', conversationId: 'c1', role: MessageRole.USER, status: 'COMPLETED', clientRequestId: 'req-1', createdAt: new Date(), updatedAt: new Date(), parts: [] };
    const assistantMessage = { id: 'm2', conversationId: 'c1', role: MessageRole.ASSISTANT, status: 'COMPLETED', clientRequestId: null, createdAt: new Date(), updatedAt: new Date(), parts: [] };
    const { whisperSpy, extractSpy } = baseParseMocks();
    const assistantChat = { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'c1' }) };
    const prisma = {
      voiceExecution: {
        create: jest.fn().mockRejectedValue(p2002()),
        findUnique: jest.fn().mockResolvedValue({ id: 'exec-1', conversationId: 'c1', status: VoiceExecutionStatus.FAILED }),
        update: jest.fn().mockResolvedValue({ id: 'exec-1', status: VoiceExecutionStatus.RECEIVED }),
      },
      meeting: { findUnique: jest.fn() },
      employee: { findMany: jest.fn().mockResolvedValue([]) },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(assistantMessage),
      },
      conversation: { update: jest.fn() },
    };
    const service = new VoiceService(
      { transcribe: whisperSpy } as any,
      { extract: extractSpy } as any,
      prisma as any,
      { log: jest.fn() } as any,
      { findAll: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      assistantChat as any,
      {} as any,
      { getPrompt: jest.fn().mockResolvedValue('') } as any,
    );
    const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' } as any;

    await service.parse(audio, makeUser(), undefined, 'req-1');

    expect(prisma.voiceExecution.update).toHaveBeenCalledWith({ where: { id: 'exec-1' }, data: { status: VoiceExecutionStatus.RECEIVED, errorMessage: null } });
    expect(whisperSpy).toHaveBeenCalledTimes(1);
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it.each([VoiceExecutionStatus.RECEIVED, VoiceExecutionStatus.PROCESSING, VoiceExecutionStatus.EXECUTING, VoiceExecutionStatus.NEEDS_RECONCILIATION])(
    '%s — отказ без единого вызова Whisper/TasksService (небезопасно трогать бизнес-логику при неуверенности)',
    async (status) => {
      const { whisperSpy, extractSpy } = baseParseMocks();
      const assistantChat = { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'c1' }) };
      const tasksSpy = { findAll: jest.fn() };
      const prisma = {
        voiceExecution: {
          create: jest.fn().mockRejectedValue(p2002()),
          findUnique: jest.fn().mockResolvedValue({ id: 'exec-1', conversationId: 'c1', status }),
        },
      };
      const service = new VoiceService({ transcribe: whisperSpy } as any, { extract: extractSpy } as any, prisma as any, {} as any, tasksSpy as any, {} as any, assistantChat as any);
      const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' } as any;

      await expect(service.parse(audio, makeUser(), undefined, 'req-1')).rejects.toThrow(/ещё выполняется|прервалась/);
      expect(whisperSpy).not.toHaveBeenCalled();
      expect(tasksSpy.findAll).not.toHaveBeenCalled();
    },
  );

  // Явно НЕ полагается на inFlightParseRequests (свежий VoiceService — Map
  // пустой, ровно как после рестарта процесса) — единственный источник
  // "не трогать бизнес-логику повторно" здесь: durable-строка VoiceExecution.
  it('post-restart (пустой in-memory Map, только БД-строка) — EXECUTING всё равно блокирует повтор', async () => {
    const { whisperSpy, extractSpy } = baseParseMocks();
    const assistantChat = { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'c1' }) };
    const tasksSpy = { findAll: jest.fn() };
    const prisma = {
      voiceExecution: {
        create: jest.fn().mockRejectedValue(p2002()),
        findUnique: jest.fn().mockResolvedValue({ id: 'exec-1', conversationId: 'c1', status: VoiceExecutionStatus.EXECUTING }),
      },
    };
    // Новый инстанс — не переиспользует promise/Map предыдущего теста,
    // моделирует ситуацию "процесс перезапустился, в памяти ничего нет".
    const freshService = new VoiceService({ transcribe: whisperSpy } as any, { extract: extractSpy } as any, prisma as any, {} as any, tasksSpy as any, {} as any, assistantChat as any);
    const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' } as any;

    await expect(freshService.parse(audio, makeUser(), undefined, 'req-1')).rejects.toThrow(/ещё выполняется|прервалась/);
    expect(whisperSpy).not.toHaveBeenCalled();
    expect(tasksSpy.findAll).not.toHaveBeenCalled();
  });

  it('успешный прогон — VoiceExecution помечается COMPLETED с реальным resultJson ДО попытки персистентности, переживает её сбой', async () => {
    const { whisperSpy, extractSpy } = baseParseMocks();
    const assistantChat = { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'c1' }) };
    const updateSpy = jest.fn().mockResolvedValue({ id: 'exec-1' });
    const prisma = {
      voiceExecution: {
        create: jest.fn().mockResolvedValue({ id: 'exec-1', status: VoiceExecutionStatus.RECEIVED }),
        update: updateSpy,
      },
      meeting: { findUnique: jest.fn() },
      employee: { findMany: jest.fn().mockResolvedValue([]) },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        // Персистентность падает (Phase H.1) — actions уже выполнены (тут
        // единственный draft — 'chat', ничего не мутирует, но путь тот же).
        create: jest.fn().mockRejectedValue(new Error('db unreachable')),
      },
    };
    const service = new VoiceService(
      { transcribe: whisperSpy } as any,
      { extract: extractSpy } as any,
      prisma as any,
      { log: jest.fn() } as any,
      { findAll: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      assistantChat as any,
      {} as any,
      { getPrompt: jest.fn().mockResolvedValue('Амир Жаксылыков, GLB, Plaud') } as any,
    );
    const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' } as any;

    const response = await service.parse(audio, makeUser(), undefined, 'req-1');

    // Персистентность действительно упала (Phase H.1, graceful degradation).
    expect(response.userMessage).toBeNull();
    // Но VoiceExecution уже COMPLETED с настоящим results — retry на этом
    // ключе теперь короткое замыкание на COMPLETED, не повторная мутация.
    const completedCall = updateSpy.mock.calls.find(([arg]: any[]) => arg.data?.status === VoiceExecutionStatus.COMPLETED);
    expect(completedCall).toBeDefined();
    expect(completedCall![0].data.resultJson.results).toEqual([{ type: 'chat', reply: 'Ок' }]);
    // Stage 2, Phase I (Company/STT vocabulary) — CompanyVocabularyService.getPrompt()
    // реально доходит до Whisper четвёртым аргументом, не только вызывается.
    expect(whisperSpy).toHaveBeenCalledWith(audio.buffer, audio.mimetype, audio.originalname, 'Амир Жаксылыков, GLB, Plaud');
  });

  it('цикл исполнения черновиков падает непредвиденно — NEEDS_RECONCILIATION, не FAILED (FAILED разрешил бы повторную мутацию)', async () => {
    const { whisperSpy, extractSpy } = baseParseMocks();
    extractSpy.mockResolvedValue({
      drafts: [{ type: 'task_action', action: 'create', targetTaskId: '', targetTitle: 'Задача', title: 'Задача', description: '', assigneeId: null, assigneeName: null, dueDate: null, priority: null, sourceMeetingId: null }],
      confidence: 'HIGH',
      clarificationNeeded: false,
      clarificationReason: 'null',
      timing: { fastMs: 1, strongMs: 0 },
      escalatedToStrongModel: false,
    });
    const assistantChat = { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'c1' }) };
    const updateSpy = jest.fn().mockResolvedValue({ id: 'exec-1' });
    const prisma = {
      voiceExecution: { create: jest.fn().mockResolvedValue({ id: 'exec-1', status: VoiceExecutionStatus.RECEIVED }), update: updateSpy },
      meeting: { findUnique: jest.fn() },
      employee: { findMany: jest.fn().mockResolvedValue([]) },
      message: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'm1', parts: [] }) },
    };
    const service = new VoiceService(
      { transcribe: whisperSpy } as any,
      { extract: extractSpy } as any,
      prisma as any,
      {} as any,
      { findAll: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      assistantChat as any,
      {} as any,
      { getPrompt: jest.fn().mockResolvedValue('') } as any,
    );
    // executeTaskAction ловит свои ошибки (никогда не бросает) — только
    // непредвиденный сбой (баг где-то ещё) может уронить сам цикл; здесь
    // смоделировано напрямую.
    jest.spyOn(service as any, 'executeTaskAction').mockRejectedValue(new Error('unexpected bug'));
    const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' } as any;

    await expect(service.parse(audio, makeUser(), undefined, 'req-1')).rejects.toThrow('unexpected bug');

    const reconciliationCall = updateSpy.mock.calls.find(([arg]: any[]) => arg.data?.status === VoiceExecutionStatus.NEEDS_RECONCILIATION);
    expect(reconciliationCall).toBeDefined();
    expect(updateSpy.mock.calls.some(([arg]: any[]) => arg.data?.status === VoiceExecutionStatus.FAILED)).toBe(false);
  });
});

// Stage 2, Phase H.1 → H.3 — второй, независимый уровень защиты
// (inFlightParseRequests) для конкурентных вызовов ВНУТРИ одного процесса:
// тот же образец, что уже применён к AssistantChatService.claimOrJoin.
describe('VoiceService.parse — exactly-once под конкурентными запросами (Phase H.1/H.3, P0/P1)', () => {
  it('два одновременных parse() с одним clientRequestId зовут whisper.transcribe ровно один раз', async () => {
    const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' } as any;
    const userMessage = { id: 'm1', conversationId: 'c1', role: MessageRole.USER, status: 'COMPLETED', clientRequestId: 'req-1', createdAt: new Date(), updatedAt: new Date(), parts: [] };
    const assistantMessage = { id: 'm2', conversationId: 'c1', role: MessageRole.ASSISTANT, status: 'COMPLETED', clientRequestId: null, createdAt: new Date(), updatedAt: new Date(), parts: [] };

    const { whisperSpy, extractSpy } = baseParseMocks();
    const assistantChat = { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: 'c1' }) };
    const prisma = {
      voiceExecution: {
        create: jest.fn().mockResolvedValue({ id: 'exec-1', status: VoiceExecutionStatus.RECEIVED }),
        update: jest.fn().mockResolvedValue({ id: 'exec-1' }),
      },
      meeting: { findUnique: jest.fn() },
      employee: { findMany: jest.fn().mockResolvedValue([]) },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(assistantMessage),
      },
      conversation: { update: jest.fn() },
    };
    const tasks = { findAll: jest.fn().mockResolvedValue([]) };
    const audit = { log: jest.fn() };
    const service = new VoiceService(
      { transcribe: whisperSpy } as any,
      { extract: extractSpy } as any,
      prisma as any,
      audit as any,
      tasks as any,
      {} as any,
      assistantChat as any,
      {} as any,
      { getPrompt: jest.fn().mockResolvedValue('') } as any,
    );

    const dto = { audio, user: makeUser(), clientRequestId: 'req-1' };
    const [resultA, resultB] = await Promise.all([
      service.parse(dto.audio, dto.user, undefined, dto.clientRequestId),
      service.parse(dto.audio, dto.user, undefined, dto.clientRequestId),
    ]);

    expect(whisperSpy).toHaveBeenCalledTimes(1);
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(prisma.voiceExecution.create).toHaveBeenCalledTimes(1);
    expect(resultA.userMessage?.id).toBe(resultB.userMessage?.id);
  });
});

// Stage 2, Phase H.1 (внешний аудит 20.09.2026, P2) — раньше голос всегда
// резолвил "последний активный разговор" (getOrCreatePrimaryConversation),
// не обязательно тот, что открыт на экране. Явный conversationId от
// клиента должен использоваться напрямую, с той же проверкой владения,
// что у текстового чата — не полагаться на эвристику там, где id уже
// известен.
describe('VoiceService.parse — явный conversationId (Phase H.1, P2)', () => {
  it('conversationId передан и принадлежит пользователю — пишет туда, getOrCreatePrimaryConversation не вызывается', async () => {
    const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' } as any;
    const userMessage = { id: 'm1', conversationId: 'c-explicit', role: MessageRole.USER, status: 'COMPLETED', clientRequestId: null, createdAt: new Date(), updatedAt: new Date(), parts: [] };
    const assistantMessage = { id: 'm2', conversationId: 'c-explicit', role: MessageRole.ASSISTANT, status: 'COMPLETED', clientRequestId: null, createdAt: new Date(), updatedAt: new Date(), parts: [] };
    const assistantChat = {
      assertOwnedConversation: jest.fn().mockResolvedValue(undefined),
      getOrCreatePrimaryConversation: jest.fn(),
    };
    const prisma = {
      meeting: { findUnique: jest.fn() },
      employee: { findMany: jest.fn().mockResolvedValue([]) },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(assistantMessage),
      },
      conversation: { update: jest.fn() },
    };
    const service = new VoiceService(
      { transcribe: jest.fn().mockResolvedValue({ text: 'Привет', durationMs: 500 }) } as any,
      { extract: jest.fn().mockResolvedValue({ drafts: [{ type: 'chat', reply: 'Ок' }], confidence: 'HIGH', clarificationNeeded: false, clarificationReason: 'null', timing: { fastMs: 1, strongMs: 0 }, escalatedToStrongModel: false }) } as any,
      prisma as any,
      { log: jest.fn() } as any,
      { findAll: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      assistantChat as any,
      {} as any,
      { getPrompt: jest.fn().mockResolvedValue('') } as any,
    );

    const response = await service.parse(audio, makeUser(), undefined, undefined, 'c-explicit');

    expect(assistantChat.assertOwnedConversation).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), 'c-explicit');
    expect(assistantChat.getOrCreatePrimaryConversation).not.toHaveBeenCalled();
    expect(response.conversationId).toBe('c-explicit');
  });

  it('conversationId передан, но не принадлежит пользователю — parse() падает до Whisper', async () => {
    const assistantChat = {
      assertOwnedConversation: jest.fn().mockRejectedValue(new Error('Диалог не найден')),
      getOrCreatePrimaryConversation: jest.fn(),
    };
    const whisperSpy = jest.fn();
    const service = new VoiceService({ transcribe: whisperSpy } as any, {} as any, {} as any, {} as any, {} as any, {} as any, assistantChat as any);
    const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/webm', originalname: 'voice.webm' } as any;

    await expect(service.parse(audio, makeUser(), undefined, undefined, 'not-mine')).rejects.toThrow('Диалог не найден');
    expect(whisperSpy).not.toHaveBeenCalled();
  });
});

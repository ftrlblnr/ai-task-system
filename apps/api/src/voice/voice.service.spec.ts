import { MessageRole, Role } from '@prisma/client';
import { VoiceService } from './voice.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import type { VoiceEventActionDraft, VoiceTaskActionDraft } from './dto/voice-draft-response.dto';

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

describe('VoiceService.executeTaskAction (Stage 2, Phase H — entity для карточки объединённой ленты)', () => {
  it('create — entity берётся из возврата TasksService.create напрямую', async () => {
    const created = { id: 't1', title: 'Задача', status: 'NEW', dueDate: null, assignee: null };
    const tasks = { create: jest.fn().mockResolvedValue(created) };
    const service = new VoiceService({} as any, {} as any, {} as any, {} as any, tasks as any, {} as any, {} as any) as any;
    const draft = taskDraft({ action: 'create' });

    const { result, entity } = await service.executeTaskAction(draft, makeUser());

    expect(result).toEqual({ type: 'task_action', draft, ok: true, error: null, taskId: 't1', previous: null });
    expect(entity).toBe(created);
  });

  it('update — entity берётся из свежего возврата TasksService.update, не из before-снимка', async () => {
    const before = { id: 't1', title: 'Старое', description: '', assignee: null, dueDate: null, priority: null };
    const updated = { id: 't1', title: 'Новое', status: 'NEW', dueDate: null, assignee: null };
    const tasks = { findOne: jest.fn().mockResolvedValue(before), update: jest.fn().mockResolvedValue(updated) };
    const service = new VoiceService({} as any, {} as any, {} as any, {} as any, tasks as any, {} as any, {} as any) as any;
    const draft = taskDraft({ action: 'update', targetTaskId: 't1', title: 'Новое' });

    const { entity } = await service.executeTaskAction(draft, makeUser());

    expect(entity).toBe(updated);
  });

  it('delete — entity=null, сущности больше нет, карточку строить не из чего', async () => {
    const tasks = { remove: jest.fn().mockResolvedValue(undefined) };
    const service = new VoiceService({} as any, {} as any, {} as any, {} as any, tasks as any, {} as any, {} as any) as any;
    const draft = taskDraft({ action: 'delete', targetTaskId: 't1' });

    const { result, entity } = await service.executeTaskAction(draft, makeUser());

    expect(entity).toBeNull();
    expect(result.ok).toBe(true);
  });

  it('ошибка — entity=null, ok=false, тот же текст исключения, что раньше уходил клиенту напрямую', async () => {
    const tasks = { create: jest.fn().mockRejectedValue(new Error('Постановщик не найден')) };
    const service = new VoiceService({} as any, {} as any, {} as any, {} as any, tasks as any, {} as any, {} as any) as any;
    const draft = taskDraft({ action: 'create' });

    const { result, entity } = await service.executeTaskAction(draft, makeUser());

    expect(entity).toBeNull();
    expect(result).toMatchObject({ ok: false, error: 'Постановщик не найден' });
  });
});

describe('VoiceService.executeEventAction (Stage 2, Phase H — entity для карточки, включая участников)', () => {
  it('create без участников — entity это created напрямую, без лишнего findOne', async () => {
    const created = { id: 'e1', title: 'Встреча', startAt: new Date(), endAt: new Date(), location: null, participants: [] };
    const events = { create: jest.fn().mockResolvedValue(created), findOne: jest.fn() };
    const service = new VoiceService({} as any, {} as any, {} as any, {} as any, {} as any, events as any, {} as any) as any;
    const draft = eventDraft({ action: 'create', addParticipantIds: [] });

    const { entity } = await service.executeEventAction(draft, makeUser({ role: Role.OWNER }));

    expect(entity).toBe(created);
    expect(events.findOne).not.toHaveBeenCalled();
  });

  it('create с участниками — entity дозапрашивается через findOne ПОСЛЕ addParticipant (у created ещё нет свежих участников)', async () => {
    const created = { id: 'e1', title: 'Встреча', startAt: new Date(), endAt: new Date(), location: null, participants: [] };
    const refetched = { ...created, participants: [{ id: 'emp1', fullName: 'Азамат' }] };
    const events = {
      create: jest.fn().mockResolvedValue(created),
      addParticipant: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(refetched),
    };
    const service = new VoiceService({} as any, {} as any, {} as any, {} as any, {} as any, events as any, {} as any) as any;
    const draft = eventDraft({ action: 'create', addParticipantIds: ['emp1'] });

    const { entity } = await service.executeEventAction(draft, makeUser({ role: Role.OWNER }));

    expect(events.addParticipant).toHaveBeenCalledWith('e1', 'emp1');
    expect(events.findOne).toHaveBeenCalledWith('e1');
    expect(entity).toBe(refetched);
  });

  it('update — entity это финальный findOne после изменения полей и участников, не before-снимок', async () => {
    const before = { id: 'e1', title: 'Старое', description: '', location: '', startAt: new Date('2026-01-01T00:00:00Z'), endAt: new Date('2026-01-01T01:00:00Z'), allDay: false };
    const finalEntity = { id: 'e1', title: 'Новое', startAt: before.startAt, endAt: before.endAt, location: null, participants: [] };
    const events = {
      findOne: jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(finalEntity),
      update: jest.fn().mockResolvedValue(undefined),
      addParticipant: jest.fn(),
      removeParticipant: jest.fn(),
    };
    const service = new VoiceService({} as any, {} as any, {} as any, {} as any, {} as any, events as any, {} as any) as any;
    const draft = eventDraft({ action: 'update', targetEventId: 'e1', title: 'Новое' });

    const { entity } = await service.executeEventAction(draft, makeUser({ role: Role.OWNER }));

    expect(entity).toBe(finalEntity);
    expect(events.findOne).toHaveBeenCalledTimes(2);
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
describe('VoiceService.undo (Stage 2, Phase H.1, P0/P1 — заменяет POST /voice/messages)', () => {
  function makeAssistantChat(conversationId = 'c1') {
    return { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue({ id: conversationId }) };
  }

  it('task create — откатывает через tasks.remove, пишет "Отменено."', async () => {
    const tasks = { remove: jest.fn().mockResolvedValue(undefined) };
    const prisma = { message: { create: jest.fn().mockResolvedValue({}) } };
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, {} as any, assistantChat as any) as any;

    const result = await service.undo({ kind: 'task', action: 'create', id: 't1' }, makeUser());

    expect(tasks.remove).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'u1' }));
    expect(result).toEqual({ ok: true, error: null });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ parts: { create: [{ type: 'MARKDOWN', order: 0, data: { content: 'Отменено.' } }] } }) }),
    );
  });

  it('task update — собирает патч из previous поштучно, не спредом (лишние поля previous не всплывают в вызове)', async () => {
    const tasks = { update: jest.fn().mockResolvedValue({}) };
    const prisma = { message: { create: jest.fn().mockResolvedValue({}) } };
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, {} as any, assistantChat as any) as any;

    const previous = { title: 'Старое название', assigneeId: null, unexpectedField: 'should be ignored' };
    await service.undo({ kind: 'task', action: 'update', id: 't1', previous }, makeUser());

    expect(tasks.update).toHaveBeenCalledWith('t1', { title: 'Старое название', assigneeId: null }, expect.objectContaining({ id: 'u1' }));
  });

  it('event create — не-OWNER получает отказ ДО вызова events.remove (защитная RBAC-проверка)', async () => {
    const events = { remove: jest.fn() };
    const prisma = { message: { create: jest.fn().mockResolvedValue({}) } };
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, events as any, assistantChat as any) as any;

    const result = await service.undo({ kind: 'event', action: 'create', id: 'e1' }, makeUser({ role: Role.EMPLOYEE }));

    expect(events.remove).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('руководителю');
  });

  it('event update — инвертирует участников (добавленные снимает, снятые возвращает)', async () => {
    const events = {
      update: jest.fn().mockResolvedValue({}),
      addParticipant: jest.fn().mockResolvedValue(undefined),
      removeParticipant: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = { message: { create: jest.fn().mockResolvedValue({}) } };
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, events as any, assistantChat as any) as any;

    await service.undo(
      {
        kind: 'event',
        action: 'update',
        id: 'e1',
        previous: {},
        addedParticipantIds: ['emp1'],
        removedParticipantIds: ['emp2'],
      },
      makeUser({ role: Role.OWNER }),
    );

    expect(events.removeParticipant).toHaveBeenCalledWith('e1', 'emp1');
    expect(events.addParticipant).toHaveBeenCalledWith('e1', 'emp2');
    expect(events.update).not.toHaveBeenCalled(); // previous пуст — нечего обновлять полями
  });

  it('ошибка отката — ok=false, безопасный текст (toErrorMessage), тоже логируется', async () => {
    const tasks = { remove: jest.fn().mockRejectedValue(new Error('Удалить задачу может только её постановщик или руководитель')) };
    const prisma = { message: { create: jest.fn().mockResolvedValue({}) } };
    const assistantChat = makeAssistantChat();
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, tasks as any, {} as any, assistantChat as any) as any;

    const result = await service.undo({ kind: 'task', action: 'create', id: 't1' }, makeUser());

    expect(result).toEqual({ ok: false, error: 'Удалить задачу может только её постановщик или руководитель' });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parts: { create: [{ type: 'MARKDOWN', order: 0, data: { content: 'Не получилось отменить: Удалить задачу может только её постановщик или руководитель' } }] },
        }),
      }),
    );
  });
});

// Stage 2, Phase H.1 (внешний аудит 20.09.2026, P0) — раньше /voice/parse
// не имел идемпотентности вовсе: сеть могла оборваться ПОСЛЕ того, как
// реальная мутация уже случилась, но ДО того, как ответ дошёл до клиента.
// findCachedParseResponse — короткое замыкание на полную (user+assistant)
// пару, без повторного Whisper/Claude/исполнения действий.
describe('VoiceService.findCachedParseResponse (Stage 2, Phase H.1, P0 — идемпотентность /voice/parse)', () => {
  it('нет существующего user-сообщения — null, продолжаем как обычную новую попытку', async () => {
    const prisma = { message: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, {} as any, {} as any) as any;

    const cached = await service.findCachedParseResponse('c1', 'req-1');

    expect(cached).toBeNull();
  });

  it('полная пара уже есть — возвращает готовый ответ, без results (не восстановить из MessagePart)', async () => {
    const userMessage = {
      id: 'm1',
      conversationId: 'c1',
      role: MessageRole.USER,
      status: 'COMPLETED',
      clientRequestId: 'req-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      parts: [{ id: 'p1', type: 'MARKDOWN', order: 0, data: { content: 'Создай задачу купить билеты' } }],
    };
    const assistantMessage = {
      id: 'm2',
      conversationId: 'c1',
      role: MessageRole.ASSISTANT,
      status: 'COMPLETED',
      clientRequestId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      parts: [{ id: 'p2', type: 'TASK_CARD', order: 0, data: { taskId: 't1', title: 'Купить билеты', status: 'NEW', dueDate: null, assignee: null } }],
    };
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue(userMessage),
        findFirst: jest.fn().mockResolvedValue(assistantMessage),
      },
    };
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, {} as any, {} as any) as any;

    const cached = await service.findCachedParseResponse('c1', 'req-1');

    expect(cached).toMatchObject({
      transcript: 'Создай задачу купить билеты',
      results: [],
      conversationId: 'c1',
    });
    expect(cached.userMessage.id).toBe('m1');
    expect(cached.assistantMessage.id).toBe('m2');
  });

  it('найден только user без ответа (прошлая попытка умерла посередине) — удаляет незавершённую строку, возвращает null', async () => {
    const userMessage = {
      id: 'm1',
      conversationId: 'c1',
      role: MessageRole.USER,
      status: 'COMPLETED',
      clientRequestId: 'req-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      parts: [{ id: 'p1', type: 'MARKDOWN', order: 0, data: { content: 'Создай задачу' } }],
    };
    const prisma = {
      message: {
        findUnique: jest.fn().mockResolvedValue(userMessage),
        findFirst: jest.fn().mockResolvedValue(null),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new VoiceService({} as any, {} as any, prisma as any, {} as any, {} as any, {} as any, {} as any) as any;

    const cached = await service.findCachedParseResponse('c1', 'req-1');

    expect(cached).toBeNull();
    expect(prisma.message.delete).toHaveBeenCalledWith({ where: { id: 'm1' } });
  });
});

import { MessageRole, Prisma, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { UndoService } from './undo.service';

// Перенесено из voice.service.spec.ts (единый агент A4): откат действий
// ассистента теперь в общем UndoService — тесты те же, конструктор короче
// (prisma, tasks, events, assistantChat).

function makeUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, ...overrides };
}

describe('UndoService.logAssistantMessage (Stage 2, Phase H — standalone-сообщение в общей ленте, не отдельная VoiceMessage)', () => {
  it('пишет ASSISTANT-сообщение без replyToMessageId в разговор от getOrCreatePrimaryConversation', async () => {
    const conversation = { id: 'c1' };
    const assistantChat = { getOrCreatePrimaryConversation: jest.fn().mockResolvedValue(conversation) };
    const prisma = { message: { create: jest.fn().mockResolvedValue({}) } };
    const service = new UndoService(prisma as any, {} as any, {} as any, assistantChat as any) as any;

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
describe('UndoService.undo (Stage 2, Phase H.1 → H.4)', () => {
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
      status: 'AVAILABLE',
      consumedAt: null,
      ...overrides,
    };
  }

  // Мок с состоянием (Stage 2, Phase L) — воспроизводит реальное поведение
  // Prisma для compound-where update: `where: {id, status: AVAILABLE}`
  // проходит только если текущий статус в моке действительно AVAILABLE,
  // иначе бросает P2025 (как настоящий Prisma на "запись под where не
  // найдена") — без этого мок не мог бы отличить "первый claim прошёл" от
  // "запись уже CLAIMED/COMPLETED", и тесты на гонку/повторный отказ были
  // бы бессмысленны (update просто всегда бы "успевал").
  function undoPrisma(record: ReturnType<typeof undoRecord> | null, messageCreate = jest.fn().mockResolvedValue({})) {
    let current = record ? { ...record } : null;
    const update = jest.fn().mockImplementation(({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (!current) return Promise.reject(new Error('not found'));
      if (where.status !== undefined && where.status !== current.status) {
        return Promise.reject(new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: '6.19.3' }));
      }
      current = { ...current, ...data };
      return Promise.resolve(current);
    });
    return {
      undoRecord: {
        findUnique: jest.fn().mockResolvedValue(record),
        update,
      },
      message: { create: messageCreate },
    };
  }

  it('task create — откатывает через tasks.remove, пишет "Отменено.", помечает UndoRecord потреблённой', async () => {
    const record = undoRecord();
    const tasks = { remove: jest.fn().mockResolvedValue(undefined) };
    const prisma = undoPrisma(record);
    const assistantChat = makeAssistantChat();
    const service = new UndoService(prisma as any, tasks as any, {} as any, assistantChat as any) as any;

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(tasks.remove).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'u1' }));
    expect(result).toEqual({ ok: true, error: null, warning: null });
    expect(prisma.undoRecord.update).toHaveBeenNthCalledWith(1, { where: { id: 'undo-1', status: 'AVAILABLE' }, data: { status: 'CLAIMED' } });
    expect(prisma.undoRecord.update).toHaveBeenNthCalledWith(2, { where: { id: 'undo-1' }, data: { status: 'COMPLETED', consumedAt: expect.any(Date) } });
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
    const service = new UndoService(prisma as any, tasks as any, {} as any, assistantChat as any) as any;

    await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(tasks.update).toHaveBeenCalledWith('t1', { title: 'Старое название', assigneeId: null }, expect.objectContaining({ id: 'u1' }));
  });

  // Находка №8 пятого аудита: если сам откат (tasks.remove/update) бросает,
  // запись должна вернуться в AVAILABLE, а не застрять в CLAIMED навсегда —
  // иначе повторное нажатие "Отменить" в пределах expiresAt получало бы
  // безопасный, но неверный "уже отменено/недействительно" и пользователь
  // терял бы возможность retry на ровном месте (временный сбой tasks.remove,
  // не осознанный отказ).
  it('откат бросает исключение → UndoRecord возвращается в AVAILABLE (не остаётся CLAIMED), ok:false с текстом ошибки', async () => {
    const record = undoRecord();
    const tasks = { remove: jest.fn().mockRejectedValue(new Error('tasks db temporarily down')) };
    const prisma = undoPrisma(record);
    const assistantChat = makeAssistantChat();
    const service = new UndoService(prisma as any, tasks as any, {} as any, assistantChat as any) as any;

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(result).toEqual({ ok: false, error: 'tasks db temporarily down', warning: null });
    expect(prisma.undoRecord.update).toHaveBeenNthCalledWith(1, { where: { id: 'undo-1', status: 'AVAILABLE' }, data: { status: 'CLAIMED' } });
    expect(prisma.undoRecord.update).toHaveBeenNthCalledWith(2, { where: { id: 'undo-1' }, data: { status: 'AVAILABLE' } });
  });

  // Находка №9 пятого аудита: сбой logAssistantMessage('Отменено.') —
  // вторичный эффект (лог) — не должен превращать уже успешно выполненный
  // откат в ok:false клиенту.
  it('успешный откат, но logAssistantMessage бросает → всё равно ok:true (лог — вторичный эффект)', async () => {
    const record = undoRecord();
    const tasks = { remove: jest.fn().mockResolvedValue(undefined) };
    const prisma = undoPrisma(record);
    const assistantChat = { ...makeAssistantChat() };
    const service = new UndoService(prisma as any, tasks as any, {} as any, assistantChat as any) as any;
    jest.spyOn(service, 'logAssistantMessage').mockRejectedValue(new Error('log db down'));

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(result).toEqual({ ok: true, error: null, warning: null });
    expect(prisma.undoRecord.update).toHaveBeenNthCalledWith(2, { where: { id: 'undo-1' }, data: { status: 'COMPLETED', consumedAt: expect.any(Date) } });
  });

  it('не найдено / не своя / уже отменена / истекла — общий безопасный текст, TasksService/EventsService не трогаются', async () => {
    const tasks = { remove: jest.fn() };
    const events = { remove: jest.fn() };
    const assistantChat = makeAssistantChat();

    // не найдено
    let prisma = undoPrisma(null);
    let service = new UndoService(prisma as any, tasks as any, events as any, assistantChat as any) as any;
    let result = await service.undo({ undoToken: 'missing' }, makeUser());
    expect(result.ok).toBe(false);
    expect(result.error).toContain('истекло');

    // чужая (employeeId не совпадает)
    prisma = undoPrisma(undoRecord({ employeeId: 'someone-else' }));
    service = new UndoService(prisma as any, tasks as any, events as any, assistantChat as any) as any;
    result = await service.undo({ undoToken: 'undo-1' }, makeUser());
    expect(result.ok).toBe(false);

    // уже отменена (или в процессе отмены — CLAIMED/COMPLETED, не AVAILABLE)
    prisma = undoPrisma(undoRecord({ status: 'COMPLETED', consumedAt: new Date() }));
    service = new UndoService(prisma as any, tasks as any, events as any, assistantChat as any) as any;
    result = await service.undo({ undoToken: 'undo-1' }, makeUser());
    expect(result.ok).toBe(false);

    // истекла
    prisma = undoPrisma(undoRecord({ expiresAt: new Date(Date.now() - 1000) }));
    service = new UndoService(prisma as any, tasks as any, events as any, assistantChat as any) as any;
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
    const service = new UndoService(prisma as any, {} as any, events as any, assistantChat as any) as any;

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
    const service = new UndoService(prisma as any, {} as any, events as any, assistantChat as any) as any;

    await service.undo({ undoToken: 'undo-1' }, makeUser({ role: Role.OWNER }));

    expect(events.removeParticipant).toHaveBeenCalledWith('e1', 'emp1', 'u1');
    expect(events.addParticipant).toHaveBeenCalledWith('e1', 'emp2', 'u1');
    expect(events.update).not.toHaveBeenCalled(); // previous пуст — нечего обновлять полями
  });

  // РЕГРЕССИЯ находки №2 седьмого внешнего аудита (Stage 2, Phase N) —
  // раньше сбой отката ОДНОГО участника логировался, но запись всё равно
  // помечалась COMPLETED и клиент получал {ok:true} без единого следа
  // проблемы — пользователь думал, что откат прошёл полностью.
  it('event update — сбой отката одного участника → status=PARTIAL, ok:true с warning, а не COMPLETED без следа', async () => {
    const record = undoRecord({
      kind: 'EVENT',
      action: 'UPDATE',
      entityId: 'e1',
      previous: {},
      addedParticipantIds: ['emp1', 'emp2'],
      removedParticipantIds: [],
    });
    const events = {
      update: jest.fn().mockResolvedValue({}),
      addParticipant: jest.fn().mockResolvedValue(undefined),
      removeParticipant: jest
        .fn()
        .mockImplementationOnce(() => Promise.resolve(undefined))
        .mockImplementationOnce(() => Promise.reject(new Error('сотрудник уже удалён'))),
    };
    const prisma = undoPrisma(record);
    const assistantChat = makeAssistantChat();
    const service = new UndoService(prisma as any, {} as any, events as any, assistantChat as any) as any;

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser({ role: Role.OWNER }));

    expect(result.ok).toBe(true);
    expect(result.warning).toContain('emp2');
    expect(prisma.undoRecord.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'undo-1' },
      data: { status: 'PARTIAL', consumedAt: expect.any(Date) },
    });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ parts: { create: [{ type: 'MARKDOWN', order: 0, data: { content: expect.stringContaining('Отменено частично') } }] } }) }),
    );
  });

  it('ошибка отката — ok=false, безопасный текст (toErrorMessage), тоже логируется', async () => {
    const record = undoRecord();
    const tasks = { remove: jest.fn().mockRejectedValue(new Error('Удалить задачу может только её постановщик или руководитель')) };
    const prisma = undoPrisma(record);
    const assistantChat = makeAssistantChat();
    const service = new UndoService(prisma as any, tasks as any, {} as any, assistantChat as any) as any;

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(result).toEqual({ ok: false, error: 'Удалить задачу может только её постановщик или руководитель', warning: null });
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
    const service = new UndoService(prisma as any, tasks as any, {} as any, assistantChat as any) as any;

    const result = await service.undo({ undoToken: 'undo-1' }, makeUser());

    expect(result.ok).toBe(false);
    expect(tasks.remove).not.toHaveBeenCalled();
  });
});

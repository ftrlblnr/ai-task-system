import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MessageStatus, Prisma, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantChatService, serializeCurrentUserTurn } from './assistant-chat.service';

function p2002(message = 'Unique constraint failed'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code: 'P2002', clientVersion: '6.19.3' });
}

// findOwnedConversation/sendMessage читают только this.prisma/this.reply —
// заглушены под конкретный сценарий каждого теста (аудит 10.09.2026, п. 5.1
// продолжается в Stage 2: RBAC-границы и идемпотентность — то, что должно
// быть протестировано отдельно от реального Anthropic/Postgres).
function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'u1', email: 'u1@example.com', role: Role.EMPLOYEE, isProfileAdmin: false, ...overrides };
}

describe('AssistantChatService.findOwnedConversation (Stage 2 §30 — conversationId одного пользователя не должен открывать чужой диалог)', () => {
  it('бросает NotFoundException для диалога другого сотрудника', async () => {
    const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', employeeId: 'someone-else' }) } };
    const service = new AssistantChatService(prisma as any, {} as any, {} as any) as any;
    await expect(service.findOwnedConversation(user(), 'c1')).rejects.toThrow(NotFoundException);
  });

  it('бросает NotFoundException для несуществующего диалога (не 403 — не подтверждаем чужому пользователю сам факт существования)', async () => {
    const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new AssistantChatService(prisma as any, {} as any, {} as any) as any;
    await expect(service.findOwnedConversation(user(), 'ghost')).rejects.toThrow(NotFoundException);
  });

  it('возвращает диалог его владельцу', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue(conversation) } };
    const service = new AssistantChatService(prisma as any, {} as any, {} as any) as any;
    await expect(service.findOwnedConversation(user(), 'c1')).resolves.toBe(conversation);
  });
});

describe('AssistantChatService.sendMessage идемпотентность (Stage 2 §29 — повторная отправка с тем же clientRequestId не создаёт вторую пару сообщений)', () => {
  it('COMPLETED-пара — короткое замыкание, ассистент и prisma.message.create не вызываются', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const existingUserMessage = { id: 'm1', createdAt: new Date('2026-01-01T00:00:00Z'), parts: [] };
    const existingAssistantMessage = { id: 'm2', status: MessageStatus.COMPLETED, createdAt: new Date('2026-01-01T00:00:01Z'), parts: [] };
    const replySpy = jest.fn();
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn().mockResolvedValue(existingUserMessage),
        findFirst: jest.fn().mockResolvedValue(existingAssistantMessage),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any, {} as any);

    const result = await service.sendMessage(user(), 'c1', { text: 'привет', clientRequestId: 'req-1' });

    expect(result).toEqual({ userMessage: existingUserMessage, assistantMessage: existingAssistantMessage });
    expect(replySpy).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('FAILED-пара — не короткое замыкание, реально повторяет попытку через update той же строки, не create', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const existingUserMessage = { id: 'm1', createdAt: new Date('2026-01-01T00:00:00Z'), parts: [] };
    const existingFailedAssistantMessage = { id: 'm2', status: MessageStatus.FAILED, createdAt: new Date('2026-01-01T00:00:01Z'), parts: [] };
    const updatedAssistantMessage = { id: 'm2', status: MessageStatus.COMPLETED, parts: [] };
    const replySpy = jest.fn().mockResolvedValue({ text: 'теперь получилось', toolCalls: [] });
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn().mockResolvedValue(existingUserMessage),
        findFirst: jest.fn().mockResolvedValue(existingFailedAssistantMessage),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(updatedAssistantMessage),
      },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any, {} as any);

    const result = await service.sendMessage(user(), 'c1', { text: 'привет', clientRequestId: 'req-1' });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm2' }, data: expect.objectContaining({ status: MessageStatus.COMPLETED }) }),
    );
    expect(result).toEqual({ userMessage: existingUserMessage, assistantMessage: updatedAssistantMessage });
  });

  it('без clientRequestId всегда создаёт новую пару сообщений (не ищет по идемпотентности)', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', role: Role.EMPLOYEE, createdAt: new Date(), parts: [] };
    const assistantMessage = { id: 'm2', createdAt: new Date(), parts: [] };
    const replySpy = jest.fn().mockResolvedValue({ text: 'привет!', toolCalls: [] });
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(assistantMessage),
      },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any, {} as any);

    const result = await service.sendMessage(user(), 'c1', { text: 'привет' });

    expect(prisma.message.findUnique).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ userMessage, assistantMessage });
  });
});

// P2.2 (Phase F.1) — streamMessage — своя логика поверх reply.streamReply
// (persist, эмит событий, retry, abort): мокируем streamReply, как выше
// мокировался reply.reply — сам Anthropic SDK не участвует (см. Context в
// плане Phase F.1 про непропорциональную стоимость мокирования SDK).
describe('AssistantChatService.streamMessage (Stage 2 Phase E/F.1)', () => {
  it('успешный стрим — message.started/part.started до вызова streamReply, tool-события с label, message.completed в конце', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const streamingAssistantMessage = { id: 'm2', createdAt: new Date(), parts: [] };
    const completedAssistantMessage = { id: 'm2', status: MessageStatus.COMPLETED, parts: [] };

    const events: unknown[] = [];
    const streamReplySpy = jest.fn().mockImplementation((_text, _history, _user, _conversationId, _userMessageId, onEvent) => {
      // К моменту вызова streamReply message.started/part.started уже должны
      // быть эмитированы вызывающим кодом.
      expect(events).toEqual([
        { event: 'message.started', messageId: 'm2', userMessage },
        { event: 'part.started', messageId: 'm2', partId: 'assistant-text' },
      ]);
      onEvent({ type: 'tool-started', name: 'get_tasks' });
      onEvent({ type: 'tool-completed', name: 'get_tasks', result: { tool: 'get_tasks', items: [], totalCount: 0 } });
      onEvent({ type: 'text-delta', delta: 'привет' });
      return { text: 'привет', toolCalls: [{ name: 'get_tasks', result: { tool: 'get_tasks', items: [], totalCount: 0 }, durationMs: 5 }] };
    });

    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(streamingAssistantMessage),
        update: jest.fn().mockResolvedValue(completedAssistantMessage),
      },
    };
    const service = new AssistantChatService(prisma as any, { streamReply: streamReplySpy } as any, {} as any);
    const abortController = new AbortController();

    await service.streamMessage(user(), 'c1', { text: 'привет' }, (e) => events.push(e), abortController.signal);

    expect(streamReplySpy).toHaveBeenCalledTimes(1);
    expect(events[0]).toEqual({ event: 'message.started', messageId: 'm2', userMessage });
    expect(events[1]).toEqual({ event: 'part.started', messageId: 'm2', partId: 'assistant-text' });
    expect(events).toContainEqual({ event: 'tool.started', messageId: 'm2', tool: 'get_tasks' });
    expect(events).toContainEqual({ event: 'tool.completed', messageId: 'm2', tool: 'get_tasks', label: 'Проверил задачи: найдено 0' });
    expect(events[events.length - 1]).toEqual({ event: 'message.completed', messageId: 'm2', message: completedAssistantMessage });
    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm2' }, data: expect.objectContaining({ status: MessageStatus.COMPLETED }) }),
    );
  });

  it('reply.streamReply бросает ошибку — message.failed эмитится, статус FAILED персистится', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const streamingAssistantMessage = { id: 'm2', createdAt: new Date(), parts: [] };
    const streamReplySpy = jest.fn().mockRejectedValue(new Error('anthropic недоступен'));
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(streamingAssistantMessage),
        update: jest.fn().mockResolvedValue({ id: 'm2', status: MessageStatus.FAILED }),
      },
    };
    const service = new AssistantChatService(prisma as any, { streamReply: streamReplySpy } as any, {} as any);
    const events: unknown[] = [];

    await service.streamMessage(user(), 'c1', { text: 'привет' }, (e) => events.push(e), new AbortController().signal);

    expect(prisma.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm2' }, data: expect.objectContaining({ status: MessageStatus.FAILED }) }),
    );
    expect(events).toContainEqual({ event: 'message.failed', messageId: 'm2', error: expect.any(String) });
  });

  it('retry FAILED через streamMessage — реально повторяет попытку через update той же строки, не create', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const existingUserMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const existingFailedAssistantMessage = { id: 'm2', status: MessageStatus.FAILED, createdAt: new Date(), parts: [] };
    const completedAssistantMessage = { id: 'm2', status: MessageStatus.COMPLETED, parts: [] };
    const streamReplySpy = jest.fn().mockResolvedValue({ text: 'теперь получилось', toolCalls: [] });
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn().mockResolvedValue(existingUserMessage),
        findFirst: jest.fn().mockResolvedValue(existingFailedAssistantMessage),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(completedAssistantMessage),
      },
    };
    const service = new AssistantChatService(prisma as any, { streamReply: streamReplySpy } as any, {} as any);
    const events: unknown[] = [];

    await service.streamMessage(user(), 'c1', { text: 'привет', clientRequestId: 'req-1' }, (e) => events.push(e), new AbortController().signal);

    expect(streamReplySpy).toHaveBeenCalledTimes(1);
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(events).toContainEqual({ event: 'message.completed', messageId: 'm2', message: completedAssistantMessage });
  });

  it('повторный вызов с тем же clientRequestId после COMPLETED — сразу message.completed, streamReply не вызывается', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const existingUserMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const existingCompletedAssistantMessage = { id: 'm2', status: MessageStatus.COMPLETED, createdAt: new Date(), parts: [] };
    const streamReplySpy = jest.fn();
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn().mockResolvedValue(existingUserMessage),
        findFirst: jest.fn().mockResolvedValue(existingCompletedAssistantMessage),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const service = new AssistantChatService(prisma as any, { streamReply: streamReplySpy } as any, {} as any);
    const events: unknown[] = [];

    await service.streamMessage(user(), 'c1', { text: 'привет', clientRequestId: 'req-1' }, (e) => events.push(e), new AbortController().signal);

    expect(streamReplySpy).not.toHaveBeenCalled();
    expect(events).toEqual([
      { event: 'message.started', messageId: 'm2', userMessage: existingUserMessage },
      { event: 'message.completed', messageId: 'm2', message: existingCompletedAssistantMessage },
    ]);
  });

  it('abortSignal реально прокидывается в reply.streamReply', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const streamingAssistantMessage = { id: 'm2', createdAt: new Date(), parts: [] };
    const streamReplySpy = jest.fn().mockResolvedValue({ text: 'ok', toolCalls: [] });
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(streamingAssistantMessage),
        update: jest.fn().mockResolvedValue({ id: 'm2', status: MessageStatus.COMPLETED, parts: [] }),
      },
    };
    const service = new AssistantChatService(prisma as any, { streamReply: streamReplySpy } as any, {} as any);
    const abortController = new AbortController();

    await service.streamMessage(user(), 'c1', { text: 'привет' }, () => undefined, abortController.signal);

    expect(streamReplySpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.anything(),
      expect.any(String),
      expect.any(String),
      expect.any(Function),
      abortController.signal,
    );
  });
});

// Stage 2, Phase F.2 (аудит 17.09.2026, P0.1) — current-turn attachments.
describe('AssistantChatService — current-turn attachments видны модели в этом же запросе', () => {
  it('sendMessage: метаданные вложения попадают в текст, отправленный reply.reply, не дублируются и не содержат самого содержимого файла', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const attachment = { id: 'f1', employeeId: 'u1', name: 'report.pdf', mimeType: 'application/pdf', size: 248134 };
    const userMessage = {
      id: 'm1',
      createdAt: new Date(),
      parts: [
        { id: 'p1', type: 'MARKDOWN', order: 0, data: { content: 'Посмотри этот документ' } },
        { id: 'p2', type: 'FILE', order: 1, data: { fileId: 'f1', name: 'report.pdf', mimeType: 'application/pdf', size: 248134 } },
      ],
    };
    const assistantMessage = { id: 'm2', createdAt: new Date(), parts: [] };
    const replySpy = jest.fn().mockResolvedValue({ text: 'Хорошо, вижу файл.', toolCalls: [] });
    const filesStub = { assertOwnedFile: jest.fn().mockResolvedValue(attachment) };
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(assistantMessage),
      },
      fileArtifact: { updateMany: jest.fn() },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any, filesStub as any);

    await service.sendMessage(user(), 'c1', { text: 'Посмотри этот документ', attachmentIds: ['f1'] });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const [sentText] = replySpy.mock.calls[0];
    expect(sentText).toContain('Посмотри этот документ');
    expect(sentText).toContain('[attached_file]');
    expect(sentText).toContain('id=f1');
    expect(sentText).toContain('name=report.pdf');
    expect(sentText).toContain('mimeType=application/pdf');
    expect(sentText).toContain('size=248134');
    // Ровно одно вхождение тега — метаданные не задублированы.
    expect(sentText.match(/\[attached_file\]/g)).toHaveLength(1);
    // Содержимое файла нигде не читается/не передаётся — assertOwnedFile
    // возвращает только метаданные FileArtifact, storage/getStream не
    // вызываются вообще (сервис их даже не знает).
    expect(filesStub.assertOwnedFile).toHaveBeenCalledWith(expect.anything(), 'f1');
  });

  it('без вложений — текст, отправленный модели, не содержит [attached_file] вообще', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', createdAt: new Date(), parts: [{ id: 'p1', type: 'MARKDOWN', order: 0, data: { content: 'привет' } }] };
    const assistantMessage = { id: 'm2', createdAt: new Date(), parts: [] };
    const replySpy = jest.fn().mockResolvedValue({ text: 'привет!', toolCalls: [] });
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(assistantMessage),
      },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any, {} as any);

    await service.sendMessage(user(), 'c1', { text: 'привет' });

    const [sentText] = replySpy.mock.calls[0];
    expect(sentText).toBe('привет');
  });
});

// Stage 2, Phase F.2 (аудит 17.09.2026, P2.11).
describe('AssistantChatService — недоступный attachment не пропускается молча', () => {
  it('sendMessage бросает BadRequestException, если attachmentId чужой/несуществующий/удалён', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const filesStub = { assertOwnedFile: jest.fn().mockRejectedValue(new NotFoundException('Файл не найден')) };
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    };
    const service = new AssistantChatService(prisma as any, {} as any, filesStub as any);

    await expect(service.sendMessage(user(), 'c1', { text: 'привет', attachmentIds: ['ghost'] })).rejects.toThrow(BadRequestException);
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('assertAttachmentsAvailable (pre-flight для streamMessage) бросает ту же ошибку', async () => {
    const filesStub = { assertOwnedFile: jest.fn().mockRejectedValue(new NotFoundException('Файл не найден')) };
    const service = new AssistantChatService({} as any, {} as any, filesStub as any);

    await expect(service.assertAttachmentsAvailable(user(), ['ghost'])).rejects.toThrow(BadRequestException);
  });

  it('без attachmentIds — assertAttachmentsAvailable ничего не бросает', async () => {
    const service = new AssistantChatService({} as any, {} as any, {} as any);
    await expect(service.assertAttachmentsAvailable(user(), undefined)).resolves.toBeUndefined();
  });
});

// Stage 2, Phase F.2 (аудит 17.09.2026, P1.7/P1.8) — два одновременных
// запроса с одним clientRequestId: findExistingPair у обоих не находит
// пару, оба пытаются создать строку, ровно один ловит P2002.
describe('AssistantChatService — идемпотентность под гонкой (P2002-recovery)', () => {
  it('sendMessage: P2002 на создании user-сообщения — переиспользует строку победителя, не бросает ошибку пользователю', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const winnerUserMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const assistantMessage = { id: 'm2', createdAt: new Date(), parts: [] };
    const replySpy = jest.fn().mockResolvedValue({ text: 'ответ', toolCalls: [] });
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        // findExistingPair: пара не найдена — оба "конкурента" видят это.
        findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winnerUserMessage),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockRejectedValueOnce(p2002()).mockResolvedValueOnce(assistantMessage),
      },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any, {} as any);

    const result = await service.sendMessage(user(), 'c1', { text: 'привет', clientRequestId: 'req-race' });

    expect(result.userMessage).toBe(winnerUserMessage);
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it('sendMessage: P2002 на создании assistant-сообщения — переиспользует строку победителя, не бросает ошибку пользователю', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const winnerAssistantMessage = { id: 'm2', status: MessageStatus.COMPLETED, createdAt: new Date(), parts: [] };
    const replySpy = jest.fn().mockResolvedValue({ text: 'ответ', toolCalls: [] });
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        // Без clientRequestId findExistingPair не зовёт findUnique/findFirst
        // вообще (короткое замыкание на "нет clientRequestId" — идемпотентность
        // тут не применима) — единственный вызов findFirst ниже приходит из
        // recovery-ветки createAssistantMessageIdempotent после P2002.
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(winnerAssistantMessage),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockRejectedValueOnce(p2002()),
      },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any, {} as any);

    const result = await service.sendMessage(user(), 'c1', { text: 'привет' });

    expect(result.assistantMessage).toBe(winnerAssistantMessage);
  });
});

// P0 (внешний аудит 20.09.2026) — идемпотентность выше защищает СТРОКИ в
// БД от дублей, но раньше не мешала двум конкурентным запросам с одним
// clientRequestId ОБА реально вызвать this.reply.reply()/streamReply() до
// того, как первый успевал записать assistant-строку. Тесты ниже — именно
// acceptance-тест, который предлагал сам аудит: Promise.all с двумя
// одновременными вызовами одного и того же логического запроса, проверка
// reply.reply()/streamReply() called === 1. Раньше такого теста не было —
// существовавшие P2002-тесты выше проверяют только recovery ПОСЛЕ того,
// как реальный вызов ассистента уже случился (или не случился) — не сам
// факт однократности вызова.
describe('AssistantChatService — exactly-once execution под конкурентными запросами (Phase F.3, P0, аудит 20.09.2026)', () => {
  it('sendMessage: два одновременных вызова с одним clientRequestId вызывают reply.reply() ровно один раз и возвращают одно и то же assistantMessage', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const assistantMessage = { id: 'm2', status: MessageStatus.COMPLETED, createdAt: new Date(), parts: [] };
    const replySpy = jest.fn().mockResolvedValue({ text: 'ответ', toolCalls: [] });
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        // Оба конкурентных вызова "не находят" существующую пару — оба
        // считают, что это первая попытка (реалистичный момент гонки: ни
        // один ещё не успел записать строку).
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        // Оба вызова resolveOrCreateUserMessage получают один и тот же
        // userMessage (в реальной БД это гарантирует unique(conversationId,
        // clientRequestId) + P2002-recovery, уже покрыто отдельным тестом
        // выше — здесь достаточно смоделировать итог, а не сам механизм
        // recovery, раз именно эта часть проверяется в другом месте).
        // create() для assistant-сообщения не должен быть вызван больше
        // одного раза, если exactly-once работает — mockResolvedValueOnce
        // после первых двух (user message) даёт третьему вызову
        // единственный валидный ответ; лишний четвёртый вызов (если бы
        // второй конкурентный запрос тоже дошёл до create) получил бы
        // undefined и тест упал бы на структуре результата, а не только
        // на счётчике reply.reply.
        create: jest
          .fn()
          .mockResolvedValueOnce(userMessage)
          .mockResolvedValueOnce(userMessage)
          .mockResolvedValueOnce(assistantMessage),
      },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any, {} as any);

    const dto = { text: 'привет', clientRequestId: 'req-1' };
    const [resultA, resultB] = await Promise.all([service.sendMessage(user(), 'c1', dto), service.sendMessage(user(), 'c1', dto)]);

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(resultA.assistantMessage).toBe(assistantMessage);
    expect(resultB.assistantMessage).toBe(assistantMessage);
  });

  it('streamMessage: два одновременных вызова с одним clientRequestId вызывают streamReply() ровно один раз; проигравший получает message.completed без повторного стрима', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const assistantMessage = { id: 'm2', status: MessageStatus.STREAMING, createdAt: new Date(), parts: [] };
    const completedMessage = { id: 'm2', status: MessageStatus.COMPLETED, createdAt: new Date(), parts: [{ id: 'p1', type: 'MARKDOWN', order: 0, data: { content: 'ответ' } }] };
    const streamReplySpy = jest.fn().mockImplementation((_text, _history, _u, _conversationId, _userMessageId, onEvent) => {
      onEvent({ type: 'text-delta', delta: 'ответ' });
      return Promise.resolve({ text: 'ответ', toolCalls: [] });
    });
    const prisma = {
      $transaction: jest.fn((fn: any) => (typeof fn === 'function' ? fn(prisma) : Promise.all(fn))),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(userMessage).mockResolvedValueOnce(assistantMessage),
        update: jest.fn().mockResolvedValue(completedMessage),
      },
    };
    const service = new AssistantChatService(prisma as any, { streamReply: streamReplySpy } as any, {} as any);

    const dto = { text: 'привет', clientRequestId: 'req-1' };
    const eventsA: any[] = [];
    const eventsB: any[] = [];
    await Promise.all([
      service.streamMessage(user(), 'c1', dto, (e) => eventsA.push(e), new AbortController().signal),
      service.streamMessage(user(), 'c1', dto, (e) => eventsB.push(e), new AbortController().signal),
    ]);

    expect(streamReplySpy).toHaveBeenCalledTimes(1);
    // Победитель — полноценные события, включая живую дельту.
    const winnerEvents = eventsA.some((e) => e.event === 'part.delta') ? eventsA : eventsB;
    const loserEvents = winnerEvents === eventsA ? eventsB : eventsA;
    expect(winnerEvents.some((e) => e.event === 'part.delta')).toBe(true);
    expect(winnerEvents.at(-1)).toMatchObject({ event: 'message.completed', message: completedMessage });
    // Проигравший — без живых дельт (streamReply не вызывался второй раз
    // ради него), но получает тот же финальный результат.
    expect(loserEvents.some((e) => e.event === 'part.delta')).toBe(false);
    expect(loserEvents.at(-1)).toMatchObject({ event: 'message.completed', message: completedMessage });
  });
});

// P1 (внешний аудит 20.09.2026) — раньше create()/update() и
// fileArtifact.updateMany() были двумя отдельными вызовами БД: сбой между
// ними оставлял FILE-часть, ссылающуюся на FileArtifact с messageId: null
// (FilesCleanupCron реаплет такой файл как orphan через 24 часа, оставляя
// в истории постоянно нерабочую ссылку). Теперь обе операции — внутри
// одного prisma.$transaction: тест проверяет именно то, что было
// НЕВОЗМОЖНО проверить раньше — сбой линковки не оставляет сообщение
// "наполовину созданным", ошибка реально долетает до вызывающего кода.
describe('AssistantChatService — транзакционная линковка Message+FileArtifact (P1, аудит 20.09.2026)', () => {
  it('sendMessage: сбой fileArtifact.updateMany внутри транзакции пробрасывается наружу, а не проглатывается', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const attachment = { id: 'f1', employeeId: 'u1', name: 'report.pdf', mimeType: 'application/pdf', size: 1000 };
    const filesStub = { assertOwnedFile: jest.fn().mockResolvedValue(attachment) };
    const prisma = {
      $transaction: jest.fn((fn: any) => fn(prisma)),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'm1', createdAt: new Date(), parts: [] }),
      },
      fileArtifact: { updateMany: jest.fn().mockRejectedValue(new Error('connection lost mid-transaction')) },
    };
    const service = new AssistantChatService(prisma as any, { reply: jest.fn() } as any, filesStub as any);

    await expect(service.sendMessage(user(), 'c1', { text: 'привет', attachmentIds: ['f1'] })).rejects.toThrow(
      'connection lost mid-transaction',
    );
  });

  it('createAssistantMessageIdempotent (не-streaming, export_tasks_xlsx) линкует сгенерированный файл в той же транзакции, что создание сообщения', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const assistantMessage = { id: 'm2', createdAt: new Date(), parts: [] };
    const replySpy = jest.fn().mockResolvedValue({
      text: 'Вот файл.',
      toolCalls: [{ name: 'export_tasks_xlsx', durationMs: 5, result: { tool: 'export_tasks_xlsx', totalCount: 3, file: { fileId: 'gen1', name: 'Задачи.xlsx', mimeType: 'x', size: 1 } } }],
    });
    const updateManySpy = jest.fn();
    const prisma = {
      $transaction: jest.fn((fn: any) => fn(prisma)),
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(assistantMessage),
      },
      fileArtifact: { updateMany: updateManySpy },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any, {} as any);

    await service.sendMessage(user(), 'c1', { text: 'экспортируй задачи' });

    expect(updateManySpy).toHaveBeenCalledWith({ where: { id: { in: ['gen1'] } }, data: { conversationId: 'c1', messageId: 'm2' } });
    // $transaction реально обёртывал оба вызова, не два независимых.
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

// Stage 2, Phase Q hardening (24.09.2026) — session.input GPT-Live и
// liveContext. Live получает только текст завершённых сообщений: карточки,
// статусы инструментов, файлы и ошибки в него не попадают.
describe('AssistantChatService.getRecentMessages — история для session.input GPT-Live', () => {
  function makeChat(rows: unknown[]) {
    const prisma = {
      conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', employeeId: 'u1' }) },
      message: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    return { service: new AssistantChatService(prisma as any, {} as any, {} as any), prisma };
  }

  it('запрашивает только COMPLETED-сообщения и только MARKDOWN-части (tool internals не попадают)', async () => {
    const { service, prisma } = makeChat([]);

    await service.getRecentMessages(user(), 'c1', 20);

    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: 'c1', status: 'COMPLETED' },
        take: 20,
        include: { parts: { where: { type: 'MARKDOWN' }, orderBy: { order: 'asc' } } },
      }),
    );
  });

  it('возвращает от старых к новым, склеивает markdown-текст, пропускает пустые', async () => {
    const { service } = makeChat([
      { role: 'ASSISTANT', parts: [{ data: { content: 'Вот задачи.' } }, { data: { content: 'Всего 6.' } }] },
      { role: 'USER', parts: [{ data: { content: 'Мы обсуждали вчера IDAT.' } }] },
      { role: 'ASSISTANT', parts: [] }, // только карточки — MARKDOWN-частей нет
    ]);

    const result = await service.getRecentMessages(user(), 'c1', 20);

    expect(result).toEqual([
      { role: 'user', text: 'Мы обсуждали вчера IDAT.' },
      { role: 'assistant', text: 'Вот задачи. Всего 6.' },
    ]);
  });

  it('чужой разговор — NotFoundException, сообщения не читаются', async () => {
    const prisma = {
      conversation: { findUnique: jest.fn().mockResolvedValue({ id: 'c1', employeeId: 'someone-else' }) },
      message: { findMany: jest.fn() },
    };
    const service = new AssistantChatService(prisma as any, {} as any, {} as any);

    await expect(service.getRecentMessages(user(), 'c1', 20)).rejects.toThrow(NotFoundException);
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });
});

describe('serializeCurrentUserTurn — liveContext только для модели', () => {
  it('без liveContext и вложений — текст как есть', () => {
    expect(serializeCurrentUserTurn('Привет', [])).toBe('Привет');
  });

  it('liveContext идёт отдельным блоком ПЕРЕД командой', () => {
    const turn = serializeCurrentUserTurn('Создай из этого задачу Жандосу.', [], 'User: Мы обсуждали IDAT.\nAssistant: Да.');

    expect(turn).toBe('[live_context]\nUser: Мы обсуждали IDAT.\nAssistant: Да.\n[/live_context]\n\nСоздай из этого задачу Жандосу.');
  });

  it('пустой liveContext игнорируется', () => {
    expect(serializeCurrentUserTurn('Привет', [], '   ')).toBe('Привет');
  });
});

import { NotFoundException } from '@nestjs/common';
import { MessageStatus, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { AssistantChatService } from './assistant-chat.service';

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
    const streamReplySpy = jest.fn().mockImplementation((_text, _history, _user, onEvent) => {
      // К моменту вызова streamReply message.started/part.started уже должны
      // быть эмитированы вызывающим кодом.
      expect(events).toEqual([
        { event: 'message.started', messageId: 'm2' },
        { event: 'part.started', messageId: 'm2', partId: 'assistant-text' },
      ]);
      onEvent({ type: 'tool-started', name: 'get_tasks' });
      onEvent({ type: 'tool-completed', name: 'get_tasks', result: { tool: 'get_tasks', items: [], totalCount: 0 } });
      onEvent({ type: 'text-delta', delta: 'привет' });
      return { text: 'привет', toolCalls: [{ name: 'get_tasks', result: { tool: 'get_tasks', items: [], totalCount: 0 }, durationMs: 5 }] };
    });

    const prisma = {
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
    expect(events[0]).toEqual({ event: 'message.started', messageId: 'm2' });
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
      { event: 'message.started', messageId: 'm2' },
      { event: 'message.completed', messageId: 'm2', message: existingCompletedAssistantMessage },
    ]);
  });

  it('abortSignal реально прокидывается в reply.streamReply', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const userMessage = { id: 'm1', createdAt: new Date(), parts: [] };
    const streamingAssistantMessage = { id: 'm2', createdAt: new Date(), parts: [] };
    const streamReplySpy = jest.fn().mockResolvedValue({ text: 'ok', toolCalls: [] });
    const prisma = {
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

    expect(streamReplySpy).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.anything(), expect.any(Function), abortController.signal);
  });
});

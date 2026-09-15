import { NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
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
    const service = new AssistantChatService(prisma as any, {} as any) as any;
    await expect(service.findOwnedConversation(user(), 'c1')).rejects.toThrow(NotFoundException);
  });

  it('бросает NotFoundException для несуществующего диалога (не 403 — не подтверждаем чужому пользователю сам факт существования)', async () => {
    const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new AssistantChatService(prisma as any, {} as any) as any;
    await expect(service.findOwnedConversation(user(), 'ghost')).rejects.toThrow(NotFoundException);
  });

  it('возвращает диалог его владельцу', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const prisma = { conversation: { findUnique: jest.fn().mockResolvedValue(conversation) } };
    const service = new AssistantChatService(prisma as any, {} as any) as any;
    await expect(service.findOwnedConversation(user(), 'c1')).resolves.toBe(conversation);
  });
});

describe('AssistantChatService.sendMessage идемпотентность (Stage 2 §29 — повторная отправка с тем же clientRequestId не создаёт вторую пару сообщений)', () => {
  it('находит уже сохранённую пару и не вызывает ассистента и prisma.message.create повторно', async () => {
    const conversation = { id: 'c1', employeeId: 'u1' };
    const existingUserMessage = { id: 'm1', createdAt: new Date('2026-01-01T00:00:00Z'), parts: [] };
    const existingAssistantMessage = { id: 'm2', createdAt: new Date('2026-01-01T00:00:01Z'), parts: [] };
    const replySpy = jest.fn();
    const prisma = {
      conversation: { findUnique: jest.fn().mockResolvedValue(conversation), update: jest.fn() },
      message: {
        findUnique: jest.fn().mockResolvedValue(existingUserMessage),
        findFirst: jest.fn().mockResolvedValue(existingAssistantMessage),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    };
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any);

    const result = await service.sendMessage(user(), 'c1', { text: 'привет', clientRequestId: 'req-1' });

    expect(result).toEqual({ userMessage: existingUserMessage, assistantMessage: existingAssistantMessage });
    expect(replySpy).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
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
    const service = new AssistantChatService(prisma as any, { reply: replySpy } as any);

    const result = await service.sendMessage(user(), 'c1', { text: 'привет' });

    expect(prisma.message.findUnique).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ userMessage, assistantMessage });
  });
});

import { MessagePartType, MessageRole, MessageStatus } from '@prisma/client';
import { toResponseConversation, toResponseMessage } from './assistant-response.mapper';

// Единственная задача маппера — перевести ЗАГЛАВНЫЕ Prisma-enum'ы в
// строчные строки публичного контракта (packages/shared-types), см.
// комментарий в самом файле. Тесты — на сам перевод, не на бизнес-логику
// (её здесь нет).
describe('toResponseMessage (Stage 2 Phase D — граница HTTP-контракта)', () => {
  it('role/status/part.type — строчные строки, не Prisma-enum как есть', () => {
    const message = {
      id: 'm1',
      conversationId: 'c1',
      role: MessageRole.ASSISTANT,
      status: MessageStatus.COMPLETED,
      clientRequestId: null,
      requestId: 'req-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:01.000Z'),
      parts: [{ id: 'p1', messageId: 'm1', type: MessagePartType.TASK_CARD, order: 0, data: { taskId: 't1' } }],
    };

    const result = toResponseMessage(message as any);

    expect(result.role).toBe('assistant');
    expect(result.status).toBe('completed');
    expect(result.parts[0].type).toBe('task_card');
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.parts[0].data).toEqual({ taskId: 't1' });
  });
});

describe('toResponseConversation', () => {
  it('archivedAt null остаётся null, не падает на отсутствующей дате', () => {
    const conversation = {
      id: 'c1',
      employeeId: 'e1',
      title: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      archivedAt: null,
    };
    expect(toResponseConversation(conversation as any).archivedAt).toBeNull();
  });
});

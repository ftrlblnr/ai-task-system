import { Conversation, Message, MessagePart, MessagePartType, MessageRole, MessageStatus } from '@prisma/client';
import type { MarkdownPartData, ErrorPartData, TaskCardData, EventCardData, ToolActivityData } from './dto/message-part-data.dto';

// Публичный HTTP-контракт (packages/shared-types) объявляет role/status/
// type строчными строками ('user'/'completed'/'markdown'), а Prisma-enum'ы
// в проекте — всегда ЗАГЛАВНЫМИ (тот же стиль, что Role/TaskStatus везде
// в схеме). Маппинг — здесь, на границе контроллера, а не в
// AssistantChatService: сервис работает с внутренним (Prisma) представлением,
// его тесты (Phase A-C) не должны знать про формат HTTP-ответа.
const ROLE_MAP: Record<MessageRole, 'user' | 'assistant'> = {
  [MessageRole.USER]: 'user',
  [MessageRole.ASSISTANT]: 'assistant',
};

const STATUS_MAP: Record<MessageStatus, 'pending' | 'streaming' | 'completed' | 'failed'> = {
  [MessageStatus.PENDING]: 'pending',
  [MessageStatus.STREAMING]: 'streaming',
  [MessageStatus.COMPLETED]: 'completed',
  [MessageStatus.FAILED]: 'failed',
};

const PART_TYPE_MAP: Record<MessagePartType, 'markdown' | 'task_card' | 'event_card' | 'file' | 'tool_activity' | 'error'> = {
  [MessagePartType.MARKDOWN]: 'markdown',
  [MessagePartType.TASK_CARD]: 'task_card',
  [MessagePartType.EVENT_CARD]: 'event_card',
  [MessagePartType.FILE]: 'file',
  [MessagePartType.TOOL_ACTIVITY]: 'tool_activity',
  [MessagePartType.ERROR]: 'error',
};

export interface ResponseMessagePart {
  id: string;
  type: 'markdown' | 'task_card' | 'event_card' | 'file' | 'tool_activity' | 'error';
  order: number;
  data: MarkdownPartData | ErrorPartData | TaskCardData | EventCardData | ToolActivityData;
}

export interface ResponseMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  status: 'pending' | 'streaming' | 'completed' | 'failed';
  clientRequestId: string | null;
  createdAt: string;
  updatedAt: string;
  parts: ResponseMessagePart[];
}

export interface ResponseConversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function toResponseMessage(message: Message & { parts: MessagePart[] }): ResponseMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: ROLE_MAP[message.role],
    status: STATUS_MAP[message.status],
    clientRequestId: message.clientRequestId,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
    parts: message.parts.map((p) => ({
      id: p.id,
      type: PART_TYPE_MAP[p.type],
      order: p.order,
      data: p.data as unknown as ResponseMessagePart['data'],
    })),
  };
}

export function toResponseConversation(conversation: Conversation): ResponseConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    archivedAt: conversation.archivedAt ? conversation.archivedAt.toISOString() : null,
  };
}

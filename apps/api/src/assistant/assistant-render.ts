import { MessagePartType, Prisma } from '@prisma/client';
import type { AssistantReplyResult } from './assistant-reply.service';
import type { ToolExecutionResult } from './assistant-tools.service';
import type { ToolActivityData } from './dto/message-part-data.dto';

export interface MessagePartInput {
  type: MessagePartType;
  order: number;
  data: Prisma.InputJsonValue;
}

// Человекочитаемый статус инструмента (спека §5.5) — никогда технические
// имена вроде "get_tasks()". totalCount, а не items.length — чтобы честно
// сказать "найдено 37", даже если в карточках показаны только первые 10
// (см. MAX_TOOL_ITEMS в assistant-tools.service.ts).
function toolActivityLabel(result: ToolExecutionResult): ToolActivityData {
  if ('error' in result) {
    const what = result.tool === 'get_events' ? 'встречи' : 'задачи';
    return { label: `Не удалось проверить ${what}` };
  }
  if (result.tool === 'get_tasks') return { label: `Проверил задачи: найдено ${result.totalCount}` };
  return { label: `Проверил календарь: найдено ${result.totalCount}` };
}

// Бэкенд-рендерер (спека §16) — LLM решает вызвать инструмент, инструмент
// возвращает реальные сущности, здесь они превращаются в MessagePart[] без
// какого-либо участия модели в форме карточки — taskId/eventId всегда из
// настоящих Task/Event, не сочинены моделью. Порядок: статус инструмента →
// текст ответа → карточки, по инструментам в порядке их вызова.
export function buildAssistantParts(result: AssistantReplyResult): MessagePartInput[] {
  const parts: MessagePartInput[] = [];
  let order = 0;

  for (const call of result.toolCalls) {
    parts.push({ type: MessagePartType.TOOL_ACTIVITY, order: order++, data: toolActivityLabel(call.result) });
  }

  parts.push({ type: MessagePartType.MARKDOWN, order: order++, data: { content: result.text } });

  for (const call of result.toolCalls) {
    if ('error' in call.result) continue;
    if (call.result.tool === 'get_tasks') {
      for (const item of call.result.items) {
        parts.push({ type: MessagePartType.TASK_CARD, order: order++, data: item });
      }
    } else {
      for (const item of call.result.items) {
        parts.push({ type: MessagePartType.EVENT_CARD, order: order++, data: item });
      }
    }
  }

  return parts;
}

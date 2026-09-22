import { MessagePartType, Prisma } from '@prisma/client';
import type { AssistantReplyResult } from './assistant-reply.service';
import type { ToolExecutionResult } from './assistant-tools.service';
import type { ToolActivityData } from './dto/message-part-data.dto';

export interface MessagePartInput {
  type: MessagePartType;
  order: number;
  data: Prisma.InputJsonValue;
}

// TaskCardData/EventCardData/ToolActivityData — именованные interface, а не
// inline-литералы, поэтому TS не считает их структурно совместимыми с
// Prisma.InputJsonValue (у него формальный index signature, у named
// interface — нет), хотя по факту это плоские JSON-совместимые объекты.
// Тот же cast, что уже применяется в проекте для Prisma Json-полей (см.
// AuditService.log/metadata) — здесь просто вынесен в одно место.
function toJson<T>(value: T): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

// Человекочитаемый статус инструмента (спека §5.5) — никогда технические
// имена вроде "get_tasks()". totalCount, а не items.length — чтобы честно
// сказать "найдено 37", даже если в карточках показаны только первые 10
// (см. MAX_TOOL_ITEMS в assistant-tools.service.ts).
export function toolActivityLabel(result: ToolExecutionResult): ToolActivityData {
  if ('error' in result) {
    // export_tasks_xlsx — отдельная формулировка (Stage 2, Phase G):
    // "Не удалось проверить файл" вводила бы в заблуждение, инструмент не
    // проверяет файл, а формирует его.
    if (result.tool === 'export_tasks_xlsx') return { label: 'Не удалось сформировать файл' };
    // Stage 2, Phase K — все четыре инструмента встреч/Plaud делят одну
    // формулировку: пользователю не важно, какой конкретно из четырёх
    // подвёл, только что раздел с встречами сейчас недоступен.
    if (
      result.tool === 'get_recent_meetings' ||
      result.tool === 'search_meetings' ||
      result.tool === 'get_meeting' ||
      result.tool === 'search_meeting_transcript'
    ) {
      return { label: 'Не удалось проверить встречи' };
    }
    const what = result.tool === 'get_events' ? 'встречи' : 'задачи';
    return { label: `Не удалось проверить ${what}` };
  }
  if (result.tool === 'get_tasks') return { label: `Проверил задачи: найдено ${result.totalCount}` };
  if (result.tool === 'get_events') return { label: `Проверил календарь: найдено ${result.totalCount}` };
  if (result.tool === 'export_tasks_xlsx') return { label: `Сформировал файл: ${result.file.name}` };
  if (result.tool === 'get_recent_meetings') return { label: `Проверил встречи: найдено ${result.totalCount}` };
  if (result.tool === 'search_meetings') return { label: `Искал встречи: найдено ${result.totalCount}` };
  if (result.tool === 'get_meeting') return { label: `Открыл встречу «${result.meeting.title}»` };
  if (result.tool === 'search_meeting_transcript') return { label: `Искал в транскриптах: найдено ${result.totalCount}` };
  // Stage 2, Phase O — create_task_from_meeting, единственный write-tool.
  return { label: `Поставил задачу «${result.task.title}»` };
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
    parts.push({ type: MessagePartType.TOOL_ACTIVITY, order: order++, data: toJson(toolActivityLabel(call.result)) });
  }

  parts.push({ type: MessagePartType.MARKDOWN, order: order++, data: { content: result.text } });

  for (const call of result.toolCalls) {
    if ('error' in call.result) continue;
    if (call.result.tool === 'get_tasks') {
      for (const item of call.result.items) {
        parts.push({ type: MessagePartType.TASK_CARD, order: order++, data: toJson(item) });
      }
    } else if (call.result.tool === 'get_events') {
      for (const item of call.result.items) {
        parts.push({ type: MessagePartType.EVENT_CARD, order: order++, data: toJson(item) });
      }
    } else if (call.result.tool === 'export_tasks_xlsx') {
      // export_tasks_xlsx — один сгенерированный файл, не список карточек
      // (Stage 2, Phase G). Тот же FILE-тип части, что и пользовательские
      // вложения (Phase F) — FilePartView на фронте уже умеет его отрендерить
      // и скачать без каких-либо изменений.
      parts.push({ type: MessagePartType.FILE, order: order++, data: toJson(call.result.file) });
    } else if (call.result.tool === 'create_task_from_meeting') {
      // Stage 2, Phase O — та же карточка, что у get_tasks (TaskCardData),
      // но с заполненным source (Task.sourceMeetingId/sourceSegmentId/
      // sourceTimestamp/sourceContext) — TaskCardView на фронте показывает
      // происхождение задачи прямо под карточкой.
      parts.push({ type: MessagePartType.TASK_CARD, order: order++, data: toJson(call.result.task) });
    }
    // Stage 2, Phase K — инструменты встреч намеренно не строят
    // отдельный тип карточки (нет MEETING_CARD/UI под неё в этом заходе,
    // владелец явно ограничил Phase K сервером/инструментами, см. финальный
    // отчёт) — ответ модели текстом (MARKDOWN выше) достаточен, tool-result
    // JSON модель уже видела и пересказала своими словами.
  }

  return parts;
}

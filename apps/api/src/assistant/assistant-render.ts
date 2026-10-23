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
    if (result.tool === 'find_employee_by_competency') return { label: 'Не удалось найти сотрудников по компетенции' };
    // Release 2 (Mail.ru Email Intelligence).
    if (result.tool === 'search_emails' || result.tool === 'get_email') return { label: 'Не удалось проверить почту' };
    if (result.tool === 'legal_ask') return { label: 'Агент-юрист не смог подготовить ответ' };
    if (result.tool === 'legal_review_contract') return { label: 'Не удалось запустить разбор договора' };
    if (result.tool === 'legal_review_status') return { label: 'Не удалось проверить разборы договоров' };
    if (result.tool === 'propose_mail_actions') return { label: 'Не удалось подготовить действия с письмами' };
    if (result.tool === 'draft_mail_reply') return { label: 'Не удалось подготовить письмо' };
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
  // Stage 2, Phase P — find_employee_by_competency, единственный оставшийся
  // read-only-инструмент этого этапа.
  if (result.tool === 'find_employee_by_competency') return { label: `Нашёл сотрудников по компетенции: ${result.employees.length}` };
  // Release 2 (Mail.ru Email Intelligence).
  if (result.tool === 'search_emails') return { label: `Проверил почту: найдено ${result.totalCount}` };
  if (result.tool === 'get_email') return { label: 'Открыл письмо' };
  if (result.tool === 'legal_ask') return { label: `Проверил по базе НПА: норм ${result.answer.citations.length}` };
  if (result.tool === 'legal_review_contract') {
    return { label: `${result.alreadyStarted ? 'Разбор уже запущен' : 'Запустил разбор договора'}: «${result.review.fileName}»` };
  }
  if (result.tool === 'legal_review_status') return { label: `Проверил разборы договоров: ${result.items.length}` };
  if (result.tool === 'propose_mail_actions') {
    const count = result.plans.reduce((n, p) => n + p.itemCount, 0);
    return { label: `Подготовил действия с письмами: ${count} — ждут подтверждения` };
  }
  if (result.tool === 'draft_mail_reply') return { label: 'Подготовил письмо — ждёт отправки' };
  // Stage 2, Phase O — create_task_from_meeting.
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
    for (const part of toolCardParts(call.result)) parts.push({ ...part, order: order++ });
  }

  return parts;
}

// Карточки одного инструмента (order проставляет вызывающий).
function toolCardParts(result: ToolExecutionResult): MessagePartInput[] {
  const parts: MessagePartInput[] = [];
  if ('error' in result) return parts;
  if (result.tool === 'get_tasks') {
    for (const item of result.items) {
      parts.push({ type: MessagePartType.TASK_CARD, order: 0, data: toJson(item) });
    }
  } else if (result.tool === 'get_events') {
    for (const item of result.items) {
      parts.push({ type: MessagePartType.EVENT_CARD, order: 0, data: toJson(item) });
    }
  } else if (result.tool === 'export_tasks_xlsx') {
    // export_tasks_xlsx — один сгенерированный файл, не список карточек
    // (Stage 2, Phase G). Тот же FILE-тип части, что и пользовательские
    // вложения (Phase F) — FilePartView на фронте уже умеет его отрендерить
    // и скачать без каких-либо изменений.
    parts.push({ type: MessagePartType.FILE, order: 0, data: toJson(result.file) });
  } else if (result.tool === 'create_task_from_meeting') {
    // Stage 2, Phase O — та же карточка, что у get_tasks (TaskCardData),
    // но с заполненным source (Task.sourceMeetingId/sourceSegmentId/
    // sourceTimestamp/sourceContext) — TaskCardView на фронте показывает
    // происхождение задачи прямо под карточкой.
    parts.push({ type: MessagePartType.TASK_CARD, order: 0, data: toJson(result.task) });
  } else if (result.tool === 'propose_mail_actions') {
    // Почта, этап 3 — карточка с кнопкой «Подтвердить»: без неё ничего не исполняется.
    for (const plan of result.plans) {
      parts.push({ type: MessagePartType.MAIL_PLAN_CARD, order: 0, data: toJson(plan) });
    }
  } else if (result.tool === 'draft_mail_reply') {
    parts.push({ type: MessagePartType.MAIL_DRAFT_CARD, order: 0, data: toJson(result.draft) });
  } else if (result.tool === 'legal_ask') {
    // Ответ агента-юриста — отдельным блоком, собранным сервером из
    // проверенных цитат: модель чата его не пересказывает (иначе цитаты
    // норм прошли бы через перефразирование и перестали быть дословными).
    parts.push({ type: MessagePartType.MARKDOWN, order: 0, data: { content: result.markdown } });
  }
  // Stage 2, Phase K — инструменты встреч намеренно не строят
  // отдельный тип карточки (нет MEETING_CARD/UI под неё в этом заходе,
  // владелец явно ограничил Phase K сервером/инструментами, см. финальный
  // отчёт) — ответ модели текстом (MARKDOWN выше) достаточен, tool-result
  // JSON модель уже видела и пересказала своими словами.
  return parts;
}

// Голосовой путь (push-to-talk и Live) берёт у ассистента текст, но карточки
// действий терять нельзя: без карточки плана/письма нечем подтвердить
// (инцидент 23.10.2026 — «перенеси в архив» голосом, план создан, кнопки нет).
// Списки get_tasks/get_events и ответ юриста голос по-прежнему пересказывает.
const VOICE_CARD_TOOLS = new Set<ToolExecutionResult['tool']>(['propose_mail_actions', 'draft_mail_reply', 'create_task_from_meeting', 'export_tasks_xlsx']);

export function voiceActionCardParts(result: AssistantReplyResult): MessagePartInput[] {
  return result.toolCalls.filter((call) => VOICE_CARD_TOOLS.has(call.result.tool)).flatMap((call) => toolCardParts(call.result));
}

import { MessagePartType, Prisma } from '@prisma/client';
import { toTaskCardData, toEventCardData } from '../assistant/assistant-tools.service';
import { stripLeakedContextMarkers } from '../assistant/assistant-reply.service';
import type { MessagePartInput } from '../assistant/assistant-render';
import type { ExecutedVoiceAction, TaskCardEntity, EventCardEntity } from './voice.service';

// Тот же приём, что toJson в assistant-render.ts — named interface (Task/
// EventCardData) формально не совместим с Prisma.InputJsonValue (у него
// index signature, у named interface нет), хотя структурно это обычный
// плоский JSON.
function toJson<T>(value: T): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

// Тот же текст, что раньше строил describeOutcome на фронте (voice-screen.tsx)
// для удаления — карточку показывать нечего, сущности больше нет, поэтому
// единственный человекочитаемый след действия — текстовая строка.
function describeDelete(targetTitle: string, kind: 'task' | 'event'): string {
  return kind === 'task' ? `Удалил задачу «${targetTitle}».` : `Удалил встречу «${targetTitle}».`;
}

// Живой прогон Phase H (владелец 20.09.2026): clarificationReason в схеме
// инструмента (draft-extraction.service.ts) — обычная строка, НЕ nullable
// (Anthropic не поддерживает nullable-строки в строгой схеме, см.
// OPTIONAL_STRING там же) — модель кладёт туда буквальный текст "null"
// (не JSON null), когда сказать нечего. Без гейта на clarificationNeeded
// каждый обычный ответ получал бы лишний markdown-пузырь с текстом "null".
// Прежний фронтенд (voice-screen.tsx) всегда проверял оба условия разом
// (`clarificationNeeded && clarificationReason`) — тот же гейт здесь,
// теперь единой точкой и для публичного поля ответа (VoiceService.parse),
// и для самой части ленты (buildVoiceAssistantParts ниже).
export function resolveClarificationReason(clarificationNeeded: boolean, clarificationReason: string | null): string | null {
  return clarificationNeeded && clarificationReason ? stripLeakedContextMarkers(clarificationReason) : null;
}

// Stage 2, Phase H — построение частей ассистентского сообщения из
// результатов голосового разбора. Один элемент execResults → одна часть, в
// том же порядке (фронтенд зипует assistantMessage.parts[i] с results[i] по
// индексу для undo/«Открыть», см. assistant-screen.tsx) — поэтому здесь нет
// веток, порождающих 0 или 2 части на один элемент. clarificationReason —
// общая оценка на весь транскрипт, не на конкретное действие, поэтому идёт
// отдельной частью последней, а не привязана ни к одному execResults[i].
// Принимает уже РЕЗОЛВНУТОЕ значение (см. resolveClarificationReason) — сам
// гейт живёт в одном месте, не дублируется на каждого вызывающего.
// result.reply уже прошёл stripLeakedContextMarkers в voice.service.ts (там
// же, где он попадает в публичное поле results) — здесь только раскладка по
// частям, без повторной санитизации того же текста.
export function buildVoiceAssistantParts(execResults: ExecutedVoiceAction[], clarificationReason: string | null): MessagePartInput[] {
  const parts: MessagePartInput[] = [];
  let order = 0;

  for (const { result, entity } of execResults) {
    if (result.type === 'chat') {
      parts.push({ type: MessagePartType.MARKDOWN, order: order++, data: toJson({ content: result.reply }) });
      continue;
    }
    if (!result.ok) {
      parts.push({ type: MessagePartType.ERROR, order: order++, data: toJson({ message: result.error ?? 'Не удалось выполнить действие' }) });
      continue;
    }
    if (result.draft.action === 'delete') {
      const kind = result.type === 'task_action' ? 'task' : 'event';
      parts.push({ type: MessagePartType.MARKDOWN, order: order++, data: toJson({ content: describeDelete(result.draft.targetTitle, kind) }) });
      continue;
    }

    // create/update, ok=true — executeTaskAction/executeEventAction в
    // voice.service.ts всегда прикладывает entity рядом с result в этом
    // случае (см. комментарий у ExecutedVoiceAction там же).
    if (result.type === 'task_action') {
      parts.push({ type: MessagePartType.TASK_CARD, order: order++, data: toJson(toTaskCardData(entity as TaskCardEntity)) });
    } else {
      // Находка №1 седьмого внешнего аудита (Stage 2, Phase N) — result.warning
      // (частичный сбой addParticipant/removeParticipant, см. VoiceService.applyParticipants)
      // раньше терялся здесь: карточка строилась только из entity, без
      // result. Подмешиваем в те же данные, что уходят в MessagePart.data —
      // так warning переживает перезагрузку истории, не только момент ответа.
      parts.push({
        type: MessagePartType.EVENT_CARD,
        order: order++,
        data: toJson({ ...toEventCardData(entity as EventCardEntity), warning: result.warning }),
      });
    }
  }

  if (clarificationReason) {
    parts.push({ type: MessagePartType.MARKDOWN, order: order++, data: toJson({ content: clarificationReason }) });
  }

  return parts;
}

// Зеркало packages/shared-types (тот же приём, что message-part-data.dto.ts
// — apps/api не подключает @ai-task-system/shared-types как зависимость).
// Событийный контракт стриминга (Stage 2 §14, Phase E) — внутренний,
// стабильный формат, НЕ сырые события Anthropic (их форма может меняться
// вместе с SDK, эта — нет, см. спеку §14: "позволит позже менять AI
// provider без переписывания UI").
import type { ResponseMessage, ResponseMessagePart } from '../assistant-response.mapper';

export type StreamEvent =
  | { event: 'message.started'; messageId: string }
  | { event: 'part.started'; messageId: string; partId: string }
  | { event: 'part.delta'; messageId: string; partId: string; delta: string }
  | { event: 'part.completed'; messageId: string; partId: string; part: ResponseMessagePart }
  | { event: 'tool.started'; messageId: string; tool: string }
  | { event: 'tool.completed'; messageId: string; tool: string; label: string }
  | { event: 'message.completed'; messageId: string; message: ResponseMessage }
  | { event: 'message.failed'; messageId: string; error: string };

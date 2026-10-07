import { Injectable } from '@nestjs/common';
import { CalendarActionStatus, CalendarActionType, CalendarAttemptOutcome } from '@prisma/client';

// Раздел 21 ТЗ — только эти 4 исхода попытки; BLOCKED_DEPENDENCY/
// CANCELLED выставляет сам движок (calendar-action-execution.service.ts),
// не исполнитель конкретного типа.
export type CalendarActionExecutorOutcome = Extract<CalendarActionStatus, 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED_CHANGED'>;

export interface CalendarActionExecutorResult {
  outcome: CalendarActionExecutorOutcome;
  providerResult?: unknown;
  errorCode?: string;
}

export interface CalendarActionExecutionContext {
  ownerId: string;
}

// Свойство-функция, не метод (та же причина, что mail-action-executor.ts:
// @typescript-eslint/unbound-method иначе подозревает небезопасный `this`
// на expect(executor.execute).toHaveBeenCalled() в тестах).
export interface CalendarActionExecutor {
  execute: (action: { id: string; targetEventId: string | null; beforeVersion: number | null; parameters: unknown }, ctx: CalendarActionExecutionContext) => Promise<CalendarActionExecutorResult>;
}

export function mapCalendarOutcomeToAttemptOutcome(outcome: CalendarActionExecutorOutcome): CalendarAttemptOutcome {
  return outcome === 'SKIPPED_CHANGED' ? 'UNKNOWN' : outcome;
}

@Injectable()
export class CalendarActionExecutorRegistry {
  private readonly executors = new Map<CalendarActionType, CalendarActionExecutor>();

  register(type: CalendarActionType, executor: CalendarActionExecutor): void {
    this.executors.set(type, executor);
  }

  get(type: CalendarActionType): CalendarActionExecutor | undefined {
    return this.executors.get(type);
  }
}

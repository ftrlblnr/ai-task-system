import { Injectable } from '@nestjs/common';
import { MailActionAttemptOutcome, MailActionItem, MailActionItemStatus, MailActionType } from '@prisma/client';

// Раздел 16 ТЗ — только эти 4 исхода попытки отображаются в статус пункта;
// SKIPPED_CHANGED — отдельный путь (раздел 14/15: "старые координаты не
// исполнять"), BLOCKED_DEPENDENCY/CANCELLED/COMPENSATED выставляет сам
// движок (mail-action-execution.service.ts), не исполнитель конкретного типа.
export type MailActionExecutorOutcome = Extract<MailActionItemStatus, 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'SKIPPED_CHANGED'>;

export interface MailActionExecutorResult {
  outcome: MailActionExecutorOutcome;
  providerResult?: unknown;
  destinationLocator?: unknown;
  errorCode?: string;
}

export interface MailActionExecutionContext {
  mailboxId: string;
}

// Один исполнитель на MailActionType (ARCHIVE/MOVE/... — Этап 1, остальные
// типы получат свой исполнитель на следующих этапах). Сам ходит в провайдер
// (EmailSession) — движок (#122) про IMAP ничего не знает, только про
// статусы/журнал.
export interface MailActionExecutor {
  execute(item: MailActionItem, ctx: MailActionExecutionContext): Promise<MailActionExecutorResult>;
}

export function mapOutcomeToAttemptOutcome(outcome: MailActionExecutorOutcome): MailActionAttemptOutcome {
  return outcome === 'SKIPPED_CHANGED' ? 'UNKNOWN' : outcome;
}

// Реестр заполняется на старте модуля (#123 регистрирует Stage 1
// исполнители) — движок обращается к нему по MailActionType, не завязан на
// конкретные классы напрямую (DI между подсистемами одного модуля всё равно
// проще через явный реестр, чем через условную цепочку if/switch на классы).
@Injectable()
export class MailActionExecutorRegistry {
  private readonly executors = new Map<MailActionType, MailActionExecutor>();

  register(type: MailActionType, executor: MailActionExecutor): void {
    this.executors.set(type, executor);
  }

  get(type: MailActionType): MailActionExecutor | undefined {
    return this.executors.get(type);
  }
}

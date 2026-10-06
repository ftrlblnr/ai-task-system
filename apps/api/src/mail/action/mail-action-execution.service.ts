import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MailActionAttemptOutcome, MailActionItem, MailActionItemStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { mapOutcomeToAttemptOutcome, MailActionExecutorRegistry, MailActionExecutorResult } from './mail-action-executor';
import { topoSortMailActionItems } from './mail-action-rules';

// Раздел 16 ТЗ — только из этих состояний можно "запустить"/"повторить"
// исполнение; пока оно QUEUED/RUNNING — стоп только взводит флаг, не трогает
// state напрямую (сам цикл в start() доводит до STOPPED между пунктами).
const RETRIABLE_EXECUTION_STATES = new Set(['DONE', 'STOPPED']);
const RETRIABLE_ITEM_STATUSES: ReadonlySet<MailActionItemStatus> = new Set(['FAILED', 'UNKNOWN']);

// Движок исполнения одобренной группы (раздел 14-16 ТЗ). Знает только про
// статусы/журнал/порядок зависимостей — САМО действие (архивировать,
// переместить и т.п.) делает MailActionExecutor конкретного типа из
// MailActionExecutorRegistry (регистрируют исполнители Этапа 1 и далее),
// этот сервис про IMAP ничего не знает.
@Injectable()
export class MailActionExecutionService {
  private readonly logger = new Logger(MailActionExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executors: MailActionExecutorRegistry,
  ) {}

  async getExecutionOrThrow(ownerId: string, executionId: string) {
    const execution = await this.prisma.mailActionExecution.findUnique({
      where: { id: executionId },
      include: { approval: { include: { plan: true } } },
    });
    if (!execution || execution.approval.plan.ownerId !== ownerId) throw new NotFoundException('Исполнение не найдено');
    return execution;
  }

  // Вызывается сразу после создания согласия (fire-and-forget из
  // MailActionApprovalService, как ReceptionNotificationsCron/
  // MailDigestCron) и из retry() ниже. Ошибка внутри НЕ должна долетать до
  // вызывающего HTTP-запроса — approve уже ответил клиенту к этому моменту.
  async start(executionId: string): Promise<void> {
    const claimed = await this.prisma.mailActionExecution.updateMany({
      where: { id: executionId, state: 'QUEUED' },
      data: { state: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count === 0) return; // уже выполняется/завершено — повторный вход не исполняет дважды

    try {
      await this.runLoop(executionId);
    } catch (err) {
      this.logger.error(`execution ${executionId} failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.prisma.mailActionExecution.update({ where: { id: executionId }, data: { state: 'STOPPED', finishedAt: new Date() } });
    }
  }

  private async runLoop(executionId: string): Promise<void> {
    const execution = await this.prisma.mailActionExecution.findUniqueOrThrow({
      where: { id: executionId },
      include: { approval: { include: { items: { include: { attempts: true } }, plan: true } } },
    });
    const mailboxId = execution.approval.plan.mailboxId;
    const ordered = topoSortMailActionItems(
      execution.approval.items.map((i) => ({ ...i, localId: i.id })),
    );

    // Видимость "подхвачено движком" до первого фактического исполнения
    // (раздел 16 ТЗ: APPROVED → QUEUED как отдельный шаг).
    await this.prisma.mailActionItem.updateMany({
      where: { id: { in: ordered.map((i) => i.id) }, status: 'APPROVED' },
      data: { status: 'QUEUED' },
    });

    const finalStatusByItemId = new Map<string, MailActionItemStatus>();
    let stopped = false;

    for (const item of ordered) {
      const fresh = await this.prisma.mailActionExecution.findUniqueOrThrow({ where: { id: executionId }, select: { cancelRequestedAt: true } });
      if (fresh.cancelRequestedAt) {
        stopped = true;
        break;
      }

      const blocked = item.dependsOnItemIds.some((depId) => finalStatusByItemId.get(depId) !== 'SUCCEEDED');
      if (blocked) {
        await this.prisma.mailActionItem.update({ where: { id: item.id }, data: { status: 'BLOCKED_DEPENDENCY', version: { increment: 1 } } });
        finalStatusByItemId.set(item.id, 'BLOCKED_DEPENDENCY');
        continue;
      }

      finalStatusByItemId.set(item.id, await this.runItem(item, mailboxId));
    }

    await this.prisma.mailActionExecution.update({
      where: { id: executionId },
      data: { state: stopped ? 'STOPPED' : 'DONE', finishedAt: new Date() },
    });
  }

  private async runItem(item: MailActionItem, mailboxId: string): Promise<MailActionItemStatus> {
    await this.prisma.mailActionItem.update({ where: { id: item.id }, data: { status: 'RUNNING', version: { increment: 1 } } });
    const attemptNumber = (await this.prisma.mailActionAttempt.count({ where: { actionId: item.id } })) + 1;

    const executor = this.executors.get(item.type);
    const result: MailActionExecutorResult = executor
      ? await executor.execute(item, { mailboxId }).catch(
          (err: unknown): MailActionExecutorResult => ({
            outcome: 'FAILED',
            errorCode: 'EXECUTOR_ERROR',
            providerResult: { message: err instanceof Error ? err.message : String(err) },
          }),
        )
      : { outcome: 'FAILED', errorCode: 'NOT_IMPLEMENTED' };

    await this.prisma.mailActionAttempt.create({
      data: {
        actionId: item.id,
        attemptNumber,
        intent: { type: item.type, parameters: item.parameters } as Prisma.InputJsonValue,
        providerResult: (result.providerResult ?? undefined) as Prisma.InputJsonValue | undefined,
        destinationLocator: (result.destinationLocator ?? undefined) as Prisma.InputJsonValue | undefined,
        errorCode: result.errorCode,
        outcome: mapOutcomeToAttemptOutcome(result.outcome) satisfies MailActionAttemptOutcome,
        finishedAt: new Date(),
      },
    });

    await this.prisma.mailActionItem.update({ where: { id: item.id }, data: { status: result.outcome, version: { increment: 1 } } });
    return result.outcome;
  }

  async stop(ownerId: string, executionId: string) {
    const execution = await this.getExecutionOrThrow(ownerId, executionId);
    if (execution.state === 'QUEUED' || execution.state === 'RUNNING') {
      await this.prisma.mailActionExecution.update({ where: { id: execution.id }, data: { cancelRequestedAt: new Date() } });
    }
    return this.prisma.mailActionExecution.findUniqueOrThrow({ where: { id: execution.id } });
  }

  async retry(ownerId: string, executionId: string) {
    const execution = await this.getExecutionOrThrow(ownerId, executionId);
    if (!RETRIABLE_EXECUTION_STATES.has(execution.state)) {
      throw new ConflictException('EXECUTION_NOT_RETRIABLE: исполнение ещё выполняется');
    }
    const retried = await this.prisma.mailActionItem.updateMany({
      where: { approvalId: execution.approvalId, status: { in: Array.from(RETRIABLE_ITEM_STATUSES) } },
      data: { status: 'QUEUED', version: { increment: 1 } },
    });
    if (retried.count === 0) {
      throw new ConflictException('NOTHING_TO_RETRY: нет пунктов в состоянии FAILED/UNKNOWN');
    }
    await this.prisma.mailActionExecution.update({
      where: { id: execution.id },
      data: { state: 'QUEUED', cancelRequestedAt: null, finishedAt: null, startedAt: null },
    });
    void this.start(execution.id).catch((err: unknown) => this.logger.error(`retry start failed: ${err instanceof Error ? err.message : String(err)}`));
    return this.prisma.mailActionExecution.findUniqueOrThrow({ where: { id: execution.id } });
  }
}

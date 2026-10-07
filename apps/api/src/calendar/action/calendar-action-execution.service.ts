import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CalendarAction, CalendarActionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CalendarActionExecutorRegistry,
  CalendarActionExecutorResult,
  mapCalendarOutcomeToAttemptOutcome,
} from './calendar-action-executor';
import { topoSortCalendarActions } from './calendar-action-rules';

// Раздел 21 ТЗ — из этих состояний можно "повторить"; пока QUEUED/RUNNING,
// стоп только взводит флаг (тот же приём, что mail/action/
// mail-action-execution.service.ts).
const RETRIABLE_EXECUTION_STATES = new Set(['DONE', 'STOPPED']);
const RETRIABLE_ACTION_STATUSES: ReadonlySet<CalendarActionStatus> = new Set(['FAILED', 'UNKNOWN']);

// Движок исполнения согласованной группы действий плана (раздел 17-18 ТЗ).
// Знает только про статусы/журнал/порядок зависимостей — САМО действие
// (создать/изменить/перенести/отменить встречу) делает
// CalendarActionExecutor конкретного типа из CalendarActionExecutorRegistry,
// этот сервис про Google Calendar/EventsService ничего не знает. Архитектура
// повторяет mail/action/mail-action-execution.service.ts.
@Injectable()
export class CalendarActionExecutionService {
  private readonly logger = new Logger(CalendarActionExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executors: CalendarActionExecutorRegistry,
  ) {}

  async getExecutionOrThrow(ownerId: string, executionId: string) {
    const execution = await this.prisma.calendarActionExecution.findUnique({
      where: { id: executionId },
      include: { authorization: { include: { plan: true } } },
    });
    if (!execution || execution.authorization.plan.ownerId !== ownerId) throw new NotFoundException('Исполнение не найдено');
    return execution;
  }

  async start(executionId: string): Promise<void> {
    const claimed = await this.prisma.calendarActionExecution.updateMany({
      where: { id: executionId, state: 'QUEUED' },
      data: { state: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count === 0) return; // уже выполняется/завершено — повторный вход не исполняет дважды

    try {
      await this.runLoop(executionId);
    } catch (err) {
      this.logger.error(`execution ${executionId} failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.prisma.calendarActionExecution.update({ where: { id: executionId }, data: { state: 'STOPPED', finishedAt: new Date() } });
      await this.updatePlanAggregateStatus(executionId);
    }
  }

  private async runLoop(executionId: string): Promise<void> {
    const execution = await this.prisma.calendarActionExecution.findUniqueOrThrow({
      where: { id: executionId },
      include: { authorization: { include: { actions: { include: { attempts: true } }, plan: true } } },
    });
    const ownerId = execution.authorization.plan.ownerId;
    const ordered = topoSortCalendarActions(execution.authorization.actions.map((a) => ({ ...a, localId: a.id })));

    const finalStatusByActionId = new Map<string, CalendarActionStatus>();
    let stopped = false;

    for (const action of ordered) {
      const fresh = await this.prisma.calendarActionExecution.findUniqueOrThrow({ where: { id: executionId }, select: { cancelRequestedAt: true } });
      if (fresh.cancelRequestedAt) {
        stopped = true;
        break;
      }

      const blocked = action.dependsOnActionIds.some((depId) => finalStatusByActionId.get(depId) !== 'SUCCEEDED');
      if (blocked) {
        await this.prisma.calendarAction.update({ where: { id: action.id }, data: { status: 'BLOCKED_DEPENDENCY', version: { increment: 1 } } });
        finalStatusByActionId.set(action.id, 'BLOCKED_DEPENDENCY');
        continue;
      }

      finalStatusByActionId.set(action.id, await this.runAction(action, { ownerId }));
    }

    await this.prisma.calendarActionExecution.update({
      where: { id: executionId },
      data: { state: stopped ? 'STOPPED' : 'DONE', finishedAt: new Date() },
    });
    await this.updatePlanAggregateStatus(executionId);
  }

  private async runAction(action: CalendarAction, ctx: { ownerId: string }): Promise<CalendarActionStatus> {
    await this.prisma.calendarAction.update({ where: { id: action.id }, data: { status: 'RUNNING', version: { increment: 1 } } });
    const attemptNumber = (await this.prisma.calendarExecutionAttempt.count({ where: { actionId: action.id } })) + 1;

    const executor = this.executors.get(action.type);
    const result: CalendarActionExecutorResult = executor
      ? await executor.execute(action, ctx).catch(
          (err: unknown): CalendarActionExecutorResult => ({
            outcome: 'FAILED',
            errorCode: 'EXECUTOR_ERROR',
            providerResult: { message: err instanceof Error ? err.message : String(err) },
          }),
        )
      : { outcome: 'FAILED', errorCode: 'NOT_IMPLEMENTED' };

    await this.prisma.calendarExecutionAttempt.create({
      data: {
        actionId: action.id,
        attemptNumber,
        intent: { type: action.type, parameters: action.parameters },
        providerResult: result.providerResult ?? undefined,
        errorCode: result.errorCode,
        outcome: mapCalendarOutcomeToAttemptOutcome(result.outcome),
        finishedAt: new Date(),
      },
    });

    await this.prisma.calendarAction.update({ where: { id: action.id }, data: { status: result.outcome, version: { increment: 1 } } });
    return result.outcome;
  }

  // Раздел 21 ТЗ — SUCCEEDED/PARTIAL/FAILED на плане, не просто "выполнен":
  // владелец должен увидеть частичный результат, а не общее "готово".
  private async updatePlanAggregateStatus(executionId: string): Promise<void> {
    const execution = await this.prisma.calendarActionExecution.findUniqueOrThrow({
      where: { id: executionId },
      include: { authorization: { include: { actions: true, plan: true } } },
    });
    const actions = execution.authorization.actions;
    const succeeded = actions.filter((a) => a.status === 'SUCCEEDED').length;
    const planStatus = succeeded === actions.length ? 'SUCCEEDED' : succeeded > 0 ? 'PARTIAL' : 'FAILED';
    await this.prisma.calendarPlan.update({ where: { id: execution.authorization.plan.id }, data: { status: planStatus } });
  }

  async stop(ownerId: string, executionId: string) {
    const execution = await this.getExecutionOrThrow(ownerId, executionId);
    if (execution.state === 'QUEUED' || execution.state === 'RUNNING') {
      await this.prisma.calendarActionExecution.update({ where: { id: execution.id }, data: { cancelRequestedAt: new Date() } });
    }
    return this.prisma.calendarActionExecution.findUniqueOrThrow({ where: { id: execution.id } });
  }

  async retry(ownerId: string, executionId: string) {
    const execution = await this.getExecutionOrThrow(ownerId, executionId);
    if (!RETRIABLE_EXECUTION_STATES.has(execution.state)) {
      throw new ConflictException('CALENDAR_EXECUTION_NOT_RETRIABLE: исполнение ещё выполняется');
    }
    const retried = await this.prisma.calendarAction.updateMany({
      where: { authorizationId: execution.authorizationId, status: { in: Array.from(RETRIABLE_ACTION_STATUSES) } },
      data: { status: 'PENDING', version: { increment: 1 } },
    });
    if (retried.count === 0) {
      throw new ConflictException('CALENDAR_NOTHING_TO_RETRY: нет действий в статусе FAILED/UNKNOWN');
    }
    await this.prisma.calendarActionExecution.update({
      where: { id: execution.id },
      data: { state: 'QUEUED', cancelRequestedAt: null, finishedAt: null, startedAt: null },
    });
    void this.start(execution.id).catch((err: unknown) => this.logger.error(`retry start failed: ${err instanceof Error ? err.message : String(err)}`));
    return this.prisma.calendarActionExecution.findUniqueOrThrow({ where: { id: execution.id } });
  }
}

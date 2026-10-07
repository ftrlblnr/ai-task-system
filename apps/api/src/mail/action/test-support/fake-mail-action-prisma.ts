/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma, тот же приём, что reception.service.spec.ts */
import { randomUUID } from 'node:crypto';
import {
  MailActionAttemptOutcome,
  MailActionExecutionState,
  MailActionGroupType,
  MailActionItemStatus,
  MailActionPlanStatus,
  MailActionRelevance,
  MailActionType,
} from '@prisma/client';

export interface FakePlan {
  id: string;
  ownerId: string;
  mailboxId: string;
  requestText: string;
  scope: unknown;
  snapshotAt: Date;
  version: number;
  status: MailActionPlanStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeItem {
  id: string;
  planId: string;
  type: MailActionType;
  groupType: MailActionGroupType;
  stableObjectIds: string[];
  sourceLocators: unknown;
  reason: string;
  evidence: unknown;
  relevance: MailActionRelevance | null;
  parameters: unknown;
  payloadHash: string;
  dependsOnItemIds: string[];
  selected: boolean;
  status: MailActionItemStatus;
  version: number;
  approvalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeApproval {
  id: string;
  actorId: string;
  planId: string;
  planVersion: number;
  groupType: MailActionGroupType;
  itemIds: string[];
  immutableActionSnapshot: unknown;
  payloadHash: string;
  status: string;
  approvedAt: Date;
  expiresAt: Date;
}

export interface FakeExecution {
  id: string;
  approvalId: string;
  state: MailActionExecutionState;
  countersByType: unknown;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface FakeAttempt {
  id: string;
  actionId: string;
  attemptNumber: number;
  intent: unknown;
  providerResult: unknown;
  destinationLocator: unknown;
  errorCode: string | undefined;
  outcome: MailActionAttemptOutcome;
  startedAt: Date;
  finishedAt: Date | null;
}

// Фейковый Prisma, ровно те модели/методы, которые реально вызывают
// MailAction{Plan,Approval,Execution}Service — тот же приём, что FakePrisma
// в reception.service.spec.ts. Юнит-тесты проверяют ветвление сервисов, не
// настоящую атомарность Postgres.
export class FakeMailActionPrisma {
  plans: FakePlan[] = [];
  items: FakeItem[] = [];
  approvals: FakeApproval[] = [];
  executions: FakeExecution[] = [];
  attempts: FakeAttempt[] = [];

  async $transaction<T>(arg: ((tx: this) => Promise<T>) | Promise<unknown>[]): Promise<T> {
    if (Array.isArray(arg)) return Promise.all(arg) as Promise<T>;
    return arg(this);
  }

  mailActionPlan = {
    create: async ({ data }: { data: Partial<FakePlan> }) => {
      const now = new Date();
      const row: FakePlan = {
        id: randomUUID(),
        version: 1,
        status: 'ANALYZING',
        createdAt: now,
        updatedAt: now,
        ...data,
      } as FakePlan;
      this.plans.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.plans.find((p) => p.id === where.id) ?? null,
    findMany: async ({ where }: { where: { ownerId: string; mailboxId: string } }) =>
      this.plans.filter((p) => p.ownerId === where.ownerId && p.mailboxId === where.mailboxId),
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakePlan> }) => {
      const row = this.plans.find((p) => p.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  };

  mailActionItem = {
    create: async ({ data }: { data: Partial<FakeItem> & { id: string } }) => {
      const now = new Date();
      const row: FakeItem = {
        selected: true,
        status: 'DRAFT',
        version: 1,
        approvalId: null,
        evidence: null,
        relevance: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      } as FakeItem;
      this.items.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.items.find((i) => i.id === where.id) ?? null,
    findMany: async ({
      where,
      include,
    }: {
      where: { id?: { in: string[] }; planId?: string; approvalId?: string };
      include?: { attempts?: unknown };
    }) => {
      const matches = this.items.filter(
        (i) =>
          (!where.id || where.id.in.includes(i.id)) &&
          (where.planId === undefined || i.planId === where.planId) &&
          (where.approvalId === undefined || i.approvalId === where.approvalId),
      );
      if (!include?.attempts) return matches;
      return matches.map((i) => ({
        ...i,
        attempts: this.attempts.filter((a) => a.actionId === i.id).sort((a, b) => b.attemptNumber - a.attemptNumber),
      }));
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.items.find((i) => i.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id?: { in: string[] }; approvalId?: string; status?: string | { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      const matches = this.items.filter((i) => {
        if (where.id && !where.id.in.includes(i.id)) return false;
        if (where.approvalId !== undefined && i.approvalId !== where.approvalId) return false;
        if (where.status !== undefined) {
          const statuses = typeof where.status === 'string' ? [where.status] : where.status.in;
          if (!statuses.includes(i.status)) return false;
        }
        return true;
      });
      for (const row of matches) applyUpdate(row, data);
      return { count: matches.length };
    },
    count: async ({ where }: { where: { actionId: string } }) => this.attempts.filter((a) => a.actionId === where.actionId).length,
  };

  mailActionApproval = {
    create: async ({ data }: { data: Partial<FakeApproval> }) => {
      const row: FakeApproval = { id: randomUUID(), status: 'ACTIVE', approvedAt: new Date(), ...data } as FakeApproval;
      this.approvals.push(row);
      return row;
    },
  };

  mailActionExecution = {
    create: async ({ data }: { data: { approvalId: string } }) => {
      const row: FakeExecution = {
        id: randomUUID(),
        approvalId: data.approvalId,
        state: 'QUEUED',
        countersByType: null,
        cancelRequestedAt: null,
        startedAt: null,
        finishedAt: null,
      };
      this.executions.push(row);
      return row;
    },
    findUnique: async ({
      where,
      select,
      include,
    }: {
      where: { id?: string; approvalId?: string };
      select?: { cancelRequestedAt: true };
      include?: unknown;
    }) => {
      const row = where.id ? this.executions.find((e) => e.id === where.id) : this.executions.find((e) => e.approvalId === where.approvalId);
      if (!row) return null;
      if (select) return { cancelRequestedAt: row.cancelRequestedAt } as never;
      if (include) return this.withIncludes(row) as never;
      return row;
    },
    findUniqueOrThrow: async (args: {
      where: { id?: string; approvalId?: string };
      select?: { cancelRequestedAt: true };
      include?: unknown;
    }) => {
      const row = await this.mailActionExecution.findUnique(args);
      if (!row) throw new Error('not found');
      return row;
    },
    updateMany: async ({ where, data }: { where: { id: string; state: string }; data: Record<string, unknown> }) => {
      const matches = this.executions.filter((e) => e.id === where.id && e.state === where.state);
      for (const row of matches) Object.assign(row, data);
      return { count: matches.length };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.executions.find((e) => e.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  };

  mailActionAttempt = {
    create: async ({ data }: { data: Omit<FakeAttempt, 'id' | 'startedAt'> }) => {
      const row: FakeAttempt = { id: randomUUID(), startedAt: new Date(), ...data };
      this.attempts.push(row);
      return row;
    },
    count: async ({ where }: { where: { actionId: string } }) => this.attempts.filter((a) => a.actionId === where.actionId).length,
  };

  // Вспомогательные методы для сборки полного графа при findUniqueOrThrow(..., {include}) —
  // упрощённая ручная сборка только того, что реально используется сервисами.
  withIncludes(execution: FakeExecution) {
    const approval = this.approvals.find((a) => a.id === execution.approvalId)!;
    const plan = this.plans.find((p) => p.id === approval.planId)!;
    const items = this.items.filter((i) => i.approvalId === approval.id).map((i) => ({ ...i, attempts: this.attempts.filter((a) => a.actionId === i.id) }));
    return { ...execution, approval: { ...approval, plan, items } };
  }
}

function applyUpdate(row: object, data: Record<string, unknown>): void {
  const target = row as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
      target[key] = (target[key] as number) + (value as { increment: number }).increment;
    } else {
      target[key] = value;
    }
  }
}

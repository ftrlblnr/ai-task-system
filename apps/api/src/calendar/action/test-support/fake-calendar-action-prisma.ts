/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma, тот же приём, что mail/action/test-support */
import { randomUUID } from 'node:crypto';
import {
  CalendarActionStatus,
  CalendarActionType,
  CalendarAttemptOutcome,
  CalendarAuthorizationBasis,
  CalendarExecutionState,
  CalendarPlanStatus,
} from '@prisma/client';

export interface FakePlan {
  id: string;
  ownerId: string;
  requestText: string;
  version: number;
  status: CalendarPlanStatus;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeAction {
  id: string;
  planId: string;
  type: CalendarActionType;
  targetEventId: string | null;
  beforeVersion: number | null;
  parameters: unknown;
  payloadHash: string;
  dependsOnActionIds: string[];
  status: CalendarActionStatus;
  version: number;
  authorizationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeAuthorization {
  id: string;
  actorId: string;
  planId: string;
  planVersion: number;
  basis: CalendarAuthorizationBasis;
  actionIds: string[];
  immutableActionSnapshot: unknown;
  payloadHash: string;
  approvedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface FakeExecution {
  id: string;
  authorizationId: string;
  state: CalendarExecutionState;
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
  errorCode: string | undefined;
  outcome: CalendarAttemptOutcome | undefined;
  startedAt: Date;
  finishedAt: Date | null;
}

function applyUpdate(row: object, data: Record<string, unknown>): void {
  const target = row as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
      target[key] = (target[key] as number) + (value as { increment: number }).increment;
    } else {
      target[key] = value;
    }
  }
}

export class FakeCalendarActionPrisma {
  plans: FakePlan[] = [];
  actions: FakeAction[] = [];
  authorizations: FakeAuthorization[] = [];
  executions: FakeExecution[] = [];
  attempts: FakeAttempt[] = [];

  async $transaction<T>(arg: ((tx: this) => Promise<T>) | Promise<unknown>[]): Promise<T> {
    if (Array.isArray(arg)) return Promise.all(arg) as Promise<T>;
    return arg(this);
  }

  calendarPlan = {
    create: async ({ data }: { data: Partial<FakePlan> & { id: string } }) => {
      const now = new Date();
      const row: FakePlan = { version: 1, status: 'DRAFT', expiresAt: null, createdAt: now, updatedAt: now, ...data } as FakePlan;
      this.plans.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.plans.find((p) => p.id === where.id) ?? null,
    findMany: async ({ where }: { where: { ownerId: string } }) => this.plans.filter((p) => p.ownerId === where.ownerId),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.plans.find((p) => p.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
  };

  calendarAction = {
    create: async ({ data }: { data: Partial<FakeAction> & { id: string } }) => {
      const now = new Date();
      const row: FakeAction = {
        status: 'PENDING',
        version: 1,
        authorizationId: null,
        targetEventId: null,
        beforeVersion: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      } as FakeAction;
      this.actions.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.actions.find((a) => a.id === where.id) ?? null,
    findMany: async ({
      where,
      include,
    }: {
      where: { id?: { in: string[] }; planId?: string; authorizationId?: string };
      include?: { attempts?: unknown };
    }) => {
      const matches = this.actions.filter(
        (a) =>
          (!where.id || where.id.in.includes(a.id)) &&
          (where.planId === undefined || a.planId === where.planId) &&
          (where.authorizationId === undefined || a.authorizationId === where.authorizationId),
      );
      if (!include?.attempts) return matches;
      return matches.map((a) => ({ ...a, attempts: this.attempts.filter((at) => at.actionId === a.id).sort((x, y) => y.attemptNumber - x.attemptNumber) }));
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.actions.find((a) => a.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id?: { in: string[] }; authorizationId?: string; status?: string | { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      const matches = this.actions.filter((a) => {
        if (where.id && !where.id.in.includes(a.id)) return false;
        if (where.authorizationId !== undefined && a.authorizationId !== where.authorizationId) return false;
        if (where.status !== undefined) {
          const statuses = typeof where.status === 'string' ? [where.status] : where.status.in;
          if (!statuses.includes(a.status)) return false;
        }
        return true;
      });
      for (const row of matches) applyUpdate(row, data);
      return { count: matches.length };
    },
  };

  calendarAuthorization = {
    create: async ({ data }: { data: Partial<FakeAuthorization> }) => {
      const row: FakeAuthorization = { id: randomUUID(), basis: 'EXPLICIT_APPROVAL', approvedAt: new Date(), revokedAt: null, ...data } as FakeAuthorization;
      this.authorizations.push(row);
      return row;
    },
  };

  calendarActionExecution = {
    create: async ({ data }: { data: { authorizationId: string } }) => {
      const row: FakeExecution = {
        id: randomUUID(),
        authorizationId: data.authorizationId,
        state: 'QUEUED',
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
      where: { id?: string; authorizationId?: string };
      select?: { cancelRequestedAt: true };
      include?: unknown;
    }) => {
      const row = where.id ? this.executions.find((e) => e.id === where.id) : this.executions.find((e) => e.authorizationId === where.authorizationId);
      if (!row) return null;
      if (select) return { cancelRequestedAt: row.cancelRequestedAt } as never;
      if (include) return this.withIncludes(row) as never;
      return row;
    },
    findUniqueOrThrow: async (args: { where: { id?: string; authorizationId?: string }; select?: { cancelRequestedAt: true }; include?: unknown }) => {
      const row = await this.calendarActionExecution.findUnique(args);
      if (!row) throw new Error('not found');
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.executions.find((e) => e.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: { id: string; state: string }; data: Record<string, unknown> }) => {
      const matches = this.executions.filter((e) => e.id === where.id && e.state === where.state);
      for (const row of matches) applyUpdate(row, data);
      return { count: matches.length };
    },
  };

  calendarExecutionAttempt = {
    create: async ({ data }: { data: Omit<FakeAttempt, 'id' | 'startedAt'> }) => {
      const row: FakeAttempt = { id: randomUUID(), startedAt: new Date(), ...data };
      this.attempts.push(row);
      return row;
    },
    count: async ({ where }: { where: { actionId: string } }) => this.attempts.filter((a) => a.actionId === where.actionId).length,
  };

  withIncludes(execution: FakeExecution) {
    const authorization = this.authorizations.find((a) => a.id === execution.authorizationId)!;
    const plan = this.plans.find((p) => p.id === authorization.planId)!;
    const actions = this.actions
      .filter((a) => a.authorizationId === authorization.id)
      .map((a) => ({ ...a, attempts: this.attempts.filter((at) => at.actionId === a.id) }));
    return { ...execution, authorization: { ...authorization, plan, actions } };
  }
}

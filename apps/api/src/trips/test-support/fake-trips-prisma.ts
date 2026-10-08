/* eslint-disable @typescript-eslint/require-await -- in-memory fake Prisma, тот же приём, что mail/calendar action test-support */
import { randomUUID } from 'node:crypto';
import type {
  AgentRunStatus,
  ExtractedFactStatus,
  ProposedChangeEntityType,
  ProposedChangeStatus,
  TripAccessRole,
  TripBookingStatus,
  TripContactRole,
  TripLegMode,
  TripMaterialStatus,
  TripPeriodPrecision,
} from '@prisma/client';

export interface FakeAgentRun {
  id: string;
  tripId: string | null;
  status: AgentRunStatus;
  initiatorId: string;
  idempotencyKey: string;
  errorSummary: string | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface FakeTripMaterial {
  id: string;
  tripId: string | null;
  agentRunId: string;
  fileArtifactId: string;
  processingStatus: TripMaterialStatus;
  addedByEmployeeId: string;
  extractionIssue: string | null;
  createdAt: Date;
}

export interface FakeTrip {
  id: string;
  humanCode: string;
  title: string;
  purposeSummary: string | null;
  organizerId: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  periodPrecision: TripPeriodPrecision;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTripMember {
  id: string;
  tripId: string;
  employeeId: string;
  accessRole: TripAccessRole;
  createdAt: Date;
}

export interface FakeTripLeg {
  id: string;
  tripId: string;
  mode: TripLegMode;
  fromLocation: string | null;
  toLocation: string | null;
  departAt: Date | null;
  departTimeZoneOffsetMinutes: number | null;
  arriveAt: Date | null;
  arriveTimeZoneOffsetMinutes: number | null;
  carrier: string | null;
  referenceCode: string | null;
  bookingStatus: TripBookingStatus;
  sourceMaterialId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTripEvent {
  id: string;
  tripId: string;
  title: string;
  startAt: Date | null;
  startTimeZoneOffsetMinutes: number | null;
  dateOnly: Date | null;
  endAt: Date | null;
  location: string | null;
  notes: string | null;
  sourceMaterialId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTripStay {
  id: string;
  tripId: string;
  name: string | null;
  address: string | null;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  bookingStatus: TripBookingStatus;
  sourceMaterialId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FakeTripContact {
  id: string;
  tripId: string;
  name: string;
  role: TripContactRole;
  organization: string | null;
  email: string | null;
  phone: string | null;
  sourceMaterialId: string | null;
  createdAt: Date;
}

export interface FakeExtractedFact {
  id: string;
  tripId: string;
  materialId: string;
  factKey: string;
  factValue: string;
  status: ExtractedFactStatus;
  extractedAt: Date;
}

export interface FakeProposedChange {
  id: string;
  tripId: string;
  agentRunId: string | null;
  materialId: string | null;
  entityType: ProposedChangeEntityType;
  entityId: string | null;
  fieldKey: string | null;
  previousValue: unknown;
  proposedValue: unknown;
  reason: string | null;
  consequences: string | null;
  status: ProposedChangeStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByEmployeeId: string | null;
}

export interface FakeTripRevision {
  id: string;
  tripId: string;
  changeId: string | null;
  entityType: ProposedChangeEntityType;
  entityId: string | null;
  summary: string;
  appliedByEmployeeId: string | null;
  appliedAt: Date;
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

export class FakeTripsPrisma {
  agentRuns: FakeAgentRun[] = [];
  tripMaterials: FakeTripMaterial[] = [];
  trips: FakeTrip[] = [];
  tripMembers: FakeTripMember[] = [];
  tripLegs: FakeTripLeg[] = [];
  tripEvents: FakeTripEvent[] = [];
  tripStays: FakeTripStay[] = [];
  tripContacts: FakeTripContact[] = [];
  extractedFacts: FakeExtractedFact[] = [];
  proposedChanges: FakeProposedChange[] = [];
  tripRevisions: FakeTripRevision[] = [];

  async $transaction<T>(arg: ((tx: this) => Promise<T>) | Promise<unknown>[]): Promise<T> {
    if (Array.isArray(arg)) return Promise.all(arg) as Promise<T>;
    return arg(this);
  }

  agentRun = {
    create: async ({
      data,
    }: {
      data: Partial<FakeAgentRun> & { initiatorId: string; idempotencyKey: string; materials?: { create: Partial<FakeTripMaterial>[] } };
    }) => {
      const now = new Date();
      const { materials, ...rest } = data;
      const row: FakeAgentRun = {
        id: randomUUID(),
        tripId: null,
        status: 'RECEIVED',
        errorSummary: null,
        lockedAt: null,
        lockedBy: null,
        attempts: 0,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        ...rest,
      };
      this.agentRuns.push(row);
      if (materials?.create) {
        for (const m of materials.create) {
          this.tripMaterials.push({
            id: randomUUID(),
            tripId: null,
            processingStatus: 'PENDING',
            extractionIssue: null,
            createdAt: now,
            agentRunId: row.id,
            ...m,
          } as FakeTripMaterial);
        }
      }
      return { ...row, materials: this.tripMaterials.filter((m) => m.agentRunId === row.id) };
    },
    findUnique: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
      if (where.id) return this.agentRuns.find((r) => r.id === where.id) ?? null;
      if (where.idempotencyKey) return this.agentRuns.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
      return null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.agentRuns.find((r) => r.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    findMany: async ({ where }: { where: { initiatorId: string } }) =>
      this.agentRuns.filter((r) => r.initiatorId === where.initiatorId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  };

  tripMaterial = {
    findMany: async ({ where }: { where: { agentRunId: string } }) => this.tripMaterials.filter((m) => m.agentRunId === where.agentRunId),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.tripMaterials.find((m) => m.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
      const rows = this.tripMaterials.filter((m) => where.id.in.includes(m.id));
      for (const row of rows) applyUpdate(row, data);
      return { count: rows.length };
    },
  };

  trip = {
    create: async ({ data }: { data: Partial<FakeTrip> & { humanCode: string; title: string; organizerId: string } }) => {
      const now = new Date();
      if (this.trips.some((t) => t.humanCode === data.humanCode)) {
        const err = new Error('Unique constraint failed on humanCode') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
      const row: FakeTrip = {
        id: randomUUID(),
        purposeSummary: null,
        periodStart: null,
        periodEnd: null,
        periodPrecision: 'UNKNOWN',
        cancelledAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.trips.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.trips.find((t) => t.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    count: async ({ where }: { where: { humanCode: { startsWith: string } } }) => this.trips.filter((t) => t.humanCode.startsWith(where.humanCode.startsWith)).length,
    findMany: async ({ where }: { where: { id?: { in: string[] }; organizerId?: string; cancelledAt?: null } }) =>
      this.trips.filter(
        (t) =>
          (where.id ? where.id.in.includes(t.id) : true) &&
          (where.organizerId ? t.organizerId === where.organizerId : true) &&
          (where.cancelledAt === null ? t.cancelledAt === null : true),
      ),
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = this.trips.find((t) => t.id === where.id);
      if (!row) throw new Error('Trip not found');
      return {
        ...row,
        legs: this.tripLegs.filter((l) => l.tripId === row.id),
        events: this.tripEvents.filter((e) => e.tripId === row.id),
        stays: this.tripStays.filter((s) => s.tripId === row.id),
        contacts: this.tripContacts.filter((c) => c.tripId === row.id),
        materials: this.tripMaterials.filter((m) => m.tripId === row.id),
        facts: this.extractedFacts.filter((f) => f.tripId === row.id),
        members: this.tripMembers.filter((mb) => mb.tripId === row.id),
      };
    },
  };

  tripMember = {
    create: async ({ data }: { data: { tripId: string; employeeId: string; accessRole: TripAccessRole } }) => {
      const row: FakeTripMember = { id: randomUUID(), createdAt: new Date(), ...data };
      this.tripMembers.push(row);
      return row;
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { tripId_employeeId: { tripId: string; employeeId: string } };
      create: { tripId: string; employeeId: string; accessRole: TripAccessRole };
      update: { accessRole: TripAccessRole };
    }) => {
      const existing = this.tripMembers.find((m) => m.tripId === where.tripId_employeeId.tripId && m.employeeId === where.tripId_employeeId.employeeId);
      if (existing) {
        applyUpdate(existing, update);
        return existing;
      }
      const row: FakeTripMember = { id: randomUUID(), createdAt: new Date(), ...create };
      this.tripMembers.push(row);
      return row;
    },
    findMany: async ({ where }: { where: { employeeId?: string; tripId?: string } }) =>
      this.tripMembers.filter((m) => (where.employeeId ? m.employeeId === where.employeeId : true) && (where.tripId ? m.tripId === where.tripId : true)),
    findUnique: async ({ where }: { where: { tripId_employeeId: { tripId: string; employeeId: string } } }) =>
      this.tripMembers.find((m) => m.tripId === where.tripId_employeeId.tripId && m.employeeId === where.tripId_employeeId.employeeId) ?? null,
    count: async ({ where }: { where: { tripId: string; accessRole: TripAccessRole } }) =>
      this.tripMembers.filter((m) => m.tripId === where.tripId && m.accessRole === where.accessRole).length,
    delete: async ({ where }: { where: { id: string } }) => {
      const idx = this.tripMembers.findIndex((m) => m.id === where.id);
      const [row] = this.tripMembers.splice(idx, 1);
      return row;
    },
  };

  tripLeg = {
    create: async ({ data }: { data: Omit<FakeTripLeg, 'id' | 'createdAt' | 'updatedAt'> }) => {
      const now = new Date();
      const row: FakeTripLeg = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
      this.tripLegs.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.tripLegs.find((l) => l.id === where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.tripLegs.find((l) => l.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const idx = this.tripLegs.findIndex((l) => l.id === where.id);
      const [row] = this.tripLegs.splice(idx, 1);
      return row;
    },
  };

  tripEvent = {
    create: async ({ data }: { data: Omit<FakeTripEvent, 'id' | 'createdAt' | 'updatedAt'> }) => {
      const now = new Date();
      const row: FakeTripEvent = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
      this.tripEvents.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.tripEvents.find((e) => e.id === where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.tripEvents.find((e) => e.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const idx = this.tripEvents.findIndex((e) => e.id === where.id);
      const [row] = this.tripEvents.splice(idx, 1);
      return row;
    },
  };

  tripStay = {
    create: async ({ data }: { data: Omit<FakeTripStay, 'id' | 'createdAt' | 'updatedAt'> }) => {
      const now = new Date();
      const row: FakeTripStay = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
      this.tripStays.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.tripStays.find((s) => s.id === where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.tripStays.find((s) => s.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const idx = this.tripStays.findIndex((s) => s.id === where.id);
      const [row] = this.tripStays.splice(idx, 1);
      return row;
    },
  };

  tripContact = {
    create: async ({ data }: { data: Omit<FakeTripContact, 'id' | 'createdAt'> }) => {
      const row: FakeTripContact = { id: randomUUID(), createdAt: new Date(), ...data };
      this.tripContacts.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.tripContacts.find((c) => c.id === where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.tripContacts.find((c) => c.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const idx = this.tripContacts.findIndex((c) => c.id === where.id);
      const [row] = this.tripContacts.splice(idx, 1);
      return row;
    },
  };

  extractedFact = {
    create: async ({ data }: { data: Omit<FakeExtractedFact, 'id' | 'extractedAt'> }) => {
      const row: FakeExtractedFact = { id: randomUUID(), extractedAt: new Date(), ...data };
      this.extractedFacts.push(row);
      return row;
    },
  };

  proposedChange = {
    create: async ({ data }: { data: Partial<FakeProposedChange> & { tripId: string; entityType: ProposedChangeEntityType; proposedValue: unknown } }) => {
      const row: FakeProposedChange = {
        id: randomUUID(),
        agentRunId: null,
        materialId: null,
        entityId: null,
        fieldKey: null,
        previousValue: null,
        reason: null,
        consequences: null,
        status: 'PENDING',
        createdAt: new Date(),
        resolvedAt: null,
        resolvedByEmployeeId: null,
        ...data,
      };
      this.proposedChanges.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }) => this.proposedChanges.find((c) => c.id === where.id) ?? null,
    findMany: async ({ where }: { where: { tripId: string; status?: ProposedChangeStatus } }) =>
      this.proposedChanges.filter((c) => c.tripId === where.tripId && (where.status ? c.status === where.status : true)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = this.proposedChanges.find((c) => c.id === where.id)!;
      applyUpdate(row, data);
      return row;
    },
  };

  tripRevision = {
    create: async ({ data }: { data: Partial<FakeTripRevision> & { tripId: string; entityType: ProposedChangeEntityType; summary: string } }) => {
      const row: FakeTripRevision = { id: randomUUID(), changeId: null, entityId: null, appliedByEmployeeId: null, appliedAt: new Date(), ...data };
      this.tripRevisions.push(row);
      return row;
    },
    findMany: async ({ where }: { where: { tripId: string } }) => this.tripRevisions.filter((r) => r.tripId === where.tripId).sort((a, b) => b.appliedAt.getTime() - a.appliedAt.getTime()),
  };
}

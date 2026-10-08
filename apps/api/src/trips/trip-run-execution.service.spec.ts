import { TripRunExecutionService } from './trip-run-execution.service';
import { FakeTripsPrisma } from './test-support/fake-trips-prisma';
import type { TripMaterialExtractionOutcome } from './trip-extraction.service';

function extractedOutcome(overrides: Partial<Parameters<typeof baseDraft>[0]> = {}, fileName = 'ticket.pdf'): TripMaterialExtractionOutcome {
  return { status: 'EXTRACTED', draft: baseDraft(overrides), fileName };
}

function baseDraft(overrides: {
  summaryHint?: string | null;
  destinationHint?: string | null;
  legDepartAt?: string | null;
} = {}) {
  return {
    readable: true,
    summaryHint: overrides.summaryHint ?? null,
    destinationHint: overrides.destinationHint ?? null,
    legs:
      overrides.legDepartAt === undefined
        ? [
            {
              mode: 'FLIGHT' as const,
              fromLocation: 'ALA',
              toLocation: 'IST',
              departAt: '2026-12-01T06:00:00.000Z',
              departTimeZoneOffsetMinutes: 300,
              arriveAt: '2026-12-01T09:00:00.000Z',
              arriveTimeZoneOffsetMinutes: 180,
              carrier: 'Air Astana',
              referenceCode: 'XYZ',
              bookingStatus: 'BOOKED' as const,
            },
          ]
        : overrides.legDepartAt === null
          ? []
          : [
              {
                mode: 'FLIGHT' as const,
                fromLocation: 'ALA',
                toLocation: 'IST',
                departAt: overrides.legDepartAt,
                departTimeZoneOffsetMinutes: null,
                arriveAt: null,
                arriveTimeZoneOffsetMinutes: null,
                carrier: null,
                referenceCode: null,
                bookingStatus: 'BOOKED' as const,
              },
            ],
    events: [],
    stays: [],
    contacts: [],
    facts: [],
    issues: [],
  };
}

async function setupRun(prisma: FakeTripsPrisma, initiatorId = 'owner-1') {
  const run = await prisma.agentRun.create({
    data: { initiatorId, idempotencyKey: `key-${Math.random()}`, materials: { create: [{ fileArtifactId: 'file-1', addedByEmployeeId: initiatorId }] } },
  });
  return run;
}

describe('TripRunExecutionService.process', () => {
  it('успешная экстракция с перелётом — создаёт Trip/TripMember/TripLeg, AgentRun переходит в READY', async () => {
    const prisma = new FakeTripsPrisma();
    const extraction = { extractOne: jest.fn().mockResolvedValue(extractedOutcome()) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma);

    await service.process({ id: run.id, initiatorId: 'owner-1' });

    const updated = prisma.agentRuns.find((r) => r.id === run.id)!;
    expect(updated.status).toBe('READY');
    expect(updated.tripId).not.toBeNull();
    expect(prisma.trips).toHaveLength(1);
    expect(prisma.trips[0].humanCode).toMatch(/^TR-\d{4}-\d{3}$/);
    expect(prisma.tripMembers).toHaveLength(1);
    expect(prisma.tripMembers[0].accessRole).toBe('ORGANIZER');
    expect(prisma.tripLegs).toHaveLength(1);
    const material = prisma.tripMaterials.find((m) => m.agentRunId === run.id)!;
    expect(material.tripId).toBe(updated.tripId);
    expect(material.processingStatus).toBe('EXTRACTED');
  });

  it('нечитаемый материал — AgentRun READY_WITH_ISSUES, TripMaterial помечен UNREADABLE', async () => {
    const prisma = new FakeTripsPrisma();
    const extraction = { extractOne: jest.fn().mockResolvedValue({ status: 'UNREADABLE', issue: 'повреждённый скан', fileName: 'scan.jpg' }) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma);

    await service.process({ id: run.id, initiatorId: 'owner-1' });

    const updated = prisma.agentRuns.find((r) => r.id === run.id)!;
    expect(updated.status).toBe('READY_WITH_ISSUES');
    const material = prisma.tripMaterials.find((m) => m.agentRunId === run.id)!;
    expect(material.processingStatus).toBe('UNREADABLE');
    expect(material.extractionIssue).toBe('повреждённый скан');
    // Карточка всё равно создаётся — раздел 3 ТЗ: "создание не требует
    // полноты материалов".
    expect(prisma.trips).toHaveLength(1);
  });

  it('похоже на уже существующую поездку того же организатора — READY_WITH_ISSUES с указанием найденной поездки', async () => {
    const prisma = new FakeTripsPrisma();
    await prisma.trip.create({
      data: { humanCode: 'TR-2026-001', title: 'Командировка в Стамбул', organizerId: 'owner-1', periodStart: new Date('2026-12-01T00:00:00.000Z'), periodPrecision: 'EXACT' },
    });
    const extraction = { extractOne: jest.fn().mockResolvedValue(extractedOutcome()) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma);

    await service.process({ id: run.id, initiatorId: 'owner-1' });

    const updated = prisma.agentRuns.find((r) => r.id === run.id)!;
    expect(updated.status).toBe('READY_WITH_ISSUES');
    expect(updated.errorSummary).toContain('Командировка в Стамбул');
  });

  it('эвристика поиска дублей не трогает поездки ДРУГИХ организаторов', async () => {
    const prisma = new FakeTripsPrisma();
    await prisma.trip.create({
      data: { humanCode: 'TR-2026-001', title: 'Чужая поездка в Стамбул', organizerId: 'someone-else', periodStart: new Date('2026-12-01T00:00:00.000Z'), periodPrecision: 'EXACT' },
    });
    const extraction = { extractOne: jest.fn().mockResolvedValue(extractedOutcome()) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma, 'owner-1');

    await service.process({ id: run.id, initiatorId: 'owner-1' });

    const updated = prisma.agentRuns.find((r) => r.id === run.id)!;
    expect(updated.status).toBe('READY');
  });

  it('сбой обработки с запасом попыток — статус возвращается в RECEIVED для повтора', async () => {
    const prisma = new FakeTripsPrisma();
    const extraction = { extractOne: jest.fn().mockRejectedValue(new Error('boom')) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma);
    const stored = prisma.agentRuns.find((r) => r.id === run.id)!;
    stored.attempts = 1;

    await service.process({ id: run.id, initiatorId: 'owner-1' });

    const updated = prisma.agentRuns.find((r) => r.id === run.id)!;
    expect(updated.status).toBe('RECEIVED');
    expect(updated.lockedAt).toBeNull();
    expect(updated.errorSummary).toContain('boom');
  });

  it('сбой обработки после исчерпания попыток — статус FAILED окончательно', async () => {
    const prisma = new FakeTripsPrisma();
    const extraction = { extractOne: jest.fn().mockRejectedValue(new Error('boom')) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma);
    const stored = prisma.agentRuns.find((r) => r.id === run.id)!;
    stored.attempts = 3;

    await service.process({ id: run.id, initiatorId: 'owner-1' });

    const updated = prisma.agentRuns.find((r) => r.id === run.id)!;
    expect(updated.status).toBe('FAILED');
    expect(updated.finishedAt).not.toBeNull();
  });

  it('humanCode при конфликте уникальности пробует следующий номер', async () => {
    const prisma = new FakeTripsPrisma();
    const year = new Date().getFullYear();
    await prisma.trip.create({ data: { humanCode: `TR-${year}-001`, title: 'Существующая', organizerId: 'owner-1' } });
    const extraction = { extractOne: jest.fn().mockResolvedValue(extractedOutcome()) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma);

    await service.process({ id: run.id, initiatorId: 'owner-1' });

    const created = prisma.trips.find((t) => t.organizerId === 'owner-1' && t.humanCode !== `TR-${year}-001`);
    expect(created).toBeDefined();
    expect(created!.humanCode).toBe(`TR-${year}-002`);
  });
});

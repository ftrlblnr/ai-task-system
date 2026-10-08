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
              departAt: '2026-12-01T06:00:00+05:00',
              arriveAt: '2026-12-01T09:00:00+03:00',
              bookingReference: 'Air Astana XYZ',
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
                arriveAt: null,
                bookingReference: null,
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

async function setupRun(prisma: FakeTripsPrisma, initiatorId = 'owner-1', tripId: string | null = null) {
  const run = await prisma.agentRun.create({
    data: { initiatorId, tripId, idempotencyKey: `key-${Math.random()}`, materials: { create: [{ fileArtifactId: 'file-1', addedByEmployeeId: initiatorId }] } },
  });
  return run;
}

describe('TripRunExecutionService.process', () => {
  it('успешная экстракция с перелётом — создаёт Trip/TripMember/TripLeg, AgentRun переходит в READY', async () => {
    const prisma = new FakeTripsPrisma();
    const extraction = { extractOne: jest.fn().mockResolvedValue(extractedOutcome()) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma);

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: null });

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

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: null });

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

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: null });

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

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: null });

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

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: null });

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

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: null });

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

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: null });

    const created = prisma.trips.find((t) => t.organizerId === 'owner-1' && t.humanCode !== `TR-${year}-001`);
    expect(created).toBeDefined();
    expect(created!.humanCode).toBe(`TR-${year}-002`);
  });
});

describe('TripRunExecutionService.process — обновление СУЩЕСТВУЮЩЕЙ поездки (Приоритет 2)', () => {
  async function setupExistingTrip(prisma: FakeTripsPrisma) {
    const trip = await prisma.trip.create({ data: { humanCode: 'TR-2026-001', title: 'Поездка', organizerId: 'owner-1' } });
    await prisma.tripMember.create({ data: { tripId: trip.id, employeeId: 'owner-1', accessRole: 'ORGANIZER' } });
    return trip;
  }

  it('новый перелёт из материала — становится ProposedChange, НЕ пишется в TripLeg прямо', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupExistingTrip(prisma);
    const extraction = { extractOne: jest.fn().mockResolvedValue(extractedOutcome()) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma, 'owner-1', trip.id);

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: trip.id });

    expect(prisma.tripLegs).toHaveLength(0);
    const legChanges = prisma.proposedChanges.filter((c) => c.entityType === 'TRIP_LEG');
    expect(legChanges).toHaveLength(1);
    expect(legChanges[0].status).toBe('PENDING');
    const updated = prisma.agentRuns.find((r) => r.id === run.id)!;
    expect(updated.status).toBe('READY_WITH_ISSUES');
    expect(updated.tripId).toBe(trip.id);
  });

  it('расширение периода — предлагается полевое изменение TRIP(period)', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupExistingTrip(prisma);
    const extraction = { extractOne: jest.fn().mockResolvedValue(extractedOutcome()) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma, 'owner-1', trip.id);

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: trip.id });

    const fieldChange = prisma.proposedChanges.find((c) => c.entityType === 'TRIP' && c.fieldKey === 'period');
    expect(fieldChange).toBeDefined();
  });

  it('материал без ничего извлекаемого, кроме факта — факт пишется прямо, не как ProposedChange', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupExistingTrip(prisma);
    const extraction = {
      extractOne: jest.fn().mockResolvedValue({
        status: 'EXTRACTED',
        fileName: 'note.txt',
        draft: { readable: true, summaryHint: null, destinationHint: null, legs: [], events: [], stays: [], contacts: [], facts: [{ key: 'виза', value: 'нужна' }], issues: [] },
      }),
    };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma, 'owner-1', trip.id);

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: trip.id });

    // Факт пишется прямо (ExtractedFact — "мягкий" слой, см. trip-change-rules.ts),
    // не становится ProposedChange — именно это проверяет тест, не итоговый
    // статус прогона (тот READY_WITH_ISSUES по другой причине: ни одного
    // leg/event/stay не нашлось ни в одном материале, см. composeTripFromMaterials).
    expect(prisma.extractedFacts).toHaveLength(1);
    expect(prisma.proposedChanges).toHaveLength(0);
  });

  it('материалы добавленного пакета получают tripId существующей поездки', async () => {
    const prisma = new FakeTripsPrisma();
    const trip = await setupExistingTrip(prisma);
    const extraction = { extractOne: jest.fn().mockResolvedValue(extractedOutcome()) };
    const service = new TripRunExecutionService(prisma as never, extraction as never);
    const run = await setupRun(prisma, 'owner-1', trip.id);

    await service.process({ id: run.id, initiatorId: 'owner-1', tripId: trip.id });

    const material = prisma.tripMaterials.find((m) => m.agentRunId === run.id)!;
    expect(material.tripId).toBe(trip.id);
  });
});

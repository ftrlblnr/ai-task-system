import { PlaudSyncStatus } from '@prisma/client';
import { PlaudSyncService } from './plaud-sync.service';

function makeConnection(overrides: Partial<{ lastSyncedCreatedAt: Date | null }> = {}) {
  return { employeeId: 'emp1', lastSyncedCreatedAt: null, ...overrides };
}

function makeListResponse(items: { id: string; name: string; created_at: string }[]) {
  return { data: items };
}

function makeDetail(id: string, name: string, createdAt: string, summary: string | null) {
  return {
    id,
    name,
    created_at: createdAt,
    note_list: summary === null ? [] : [{ data_type: 'auto_sum_note', data_content: summary }],
  };
}

describe('PlaudSyncService.pullChanges', () => {
  it('нет подключения — ничего не делает, к API не обращается', async () => {
    const prisma = { plaudConnection: { findUnique: jest.fn().mockResolvedValue(null) } };
    const api = { listFiles: jest.fn() };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(api.listFiles).not.toHaveBeenCalled();
  });

  it('новая запись с готовым summary — создаёт Meeting и PlaudSyncItem(SYNCED), продвигает курсор', async () => {
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection()), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      meeting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'm1' }), update: jest.fn() },
    };
    const api = {
      listFiles: jest.fn().mockResolvedValueOnce(makeListResponse([{ id: 'p1', name: 'Встреча', created_at: '2026-09-01T10:00:00Z' }])).mockResolvedValueOnce(makeListResponse([])),
      getFile: jest.fn().mockResolvedValue(makeDetail('p1', 'Встреча', '2026-09-01T10:00:00Z', 'Саммари встречи')),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.meeting.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Встреча', rawSummary: 'Саммари встречи', plaudRecordingId: 'p1' }) }),
    );
    expect(prisma.plaudSyncItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ status: PlaudSyncStatus.SYNCED, meetingId: 'm1' }) }),
    );
    expect(prisma.plaudConnection.update).toHaveBeenCalledWith({
      where: { employeeId: 'emp1' },
      data: { lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z'), lastSyncAt: expect.any(Date) },
    });
  });

  // Регрессия бага #1 (внешний аудит 21.09.2026): раньше запись без
  // готового summary терялась НАВСЕГДА, потому что курсор продвигался
  // мимо неё, а отдельной памяти "видели, но не синхронизировали" не было.
  it('РЕГРЕССИЯ бага #1 — запись без summary не теряется: следующий прогон подхватывает её из PlaudSyncItem, не из discovery по курсору', async () => {
    let trackingRow: any = null;
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection()), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(trackingRow && where.status?.in?.includes(trackingRow.status) ? [trackingRow] : []),
        ),
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(trackingRow)),
        upsert: jest.fn().mockImplementation(({ create, update }: any) => {
          trackingRow = trackingRow ? { ...trackingRow, ...update } : { plaudRecordingId: 'p1', ...create };
          return Promise.resolve(trackingRow);
        }),
      },
      meeting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'm1' }), update: jest.fn() },
    };
    const api = {
      listFiles: jest.fn(),
      getFile: jest.fn(),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    // Первый прогон: запись найдена, но summary ещё не готов.
    api.listFiles.mockResolvedValueOnce(makeListResponse([{ id: 'p1', name: 'Встреча', created_at: '2026-09-01T10:00:00Z' }])).mockResolvedValueOnce(makeListResponse([]));
    api.getFile.mockResolvedValueOnce(makeDetail('p1', 'Встреча', '2026-09-01T10:00:00Z', null));
    await service.pullChanges('emp1');

    expect(trackingRow.status).toBe(PlaudSyncStatus.WAITING_FOR_CONTENT);
    expect(prisma.meeting.create).not.toHaveBeenCalled();
    // Курсор всё равно продвинулся (как и раньше) — но теперь это не
    // теряет запись, а PlaudSyncItem её помнит отдельно.
    expect(prisma.plaudConnection.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') }) }),
    );

    // Второй прогон: список файлов от Plaud больше не содержит p1 (он
    // старше курсора, discovery его не найдёт) — но summary уже готов.
    api.listFiles.mockResolvedValueOnce(makeListResponse([])); // discovery: ничего нового
    api.getFile.mockResolvedValueOnce(makeDetail('p1', 'Встреча', '2026-09-01T10:00:00Z', 'Саммари готово'));
    await service.pullChanges('emp1');

    expect(prisma.meeting.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rawSummary: 'Саммари готово' }) }));
    expect(trackingRow.status).toBe(PlaudSyncStatus.SYNCED);
  });

  // Регрессия бага #2: уже импортированная запись раньше никогда не
  // обновлялась при изменении содержимого на стороне Plaud. rawSummary
  // намеренно НЕ обновляется (см. комментарий в schema.prisma/сервисе —
  // раздел 8.1 ТЗ требует её неизменности), обновляется только title.
  it('РЕГРЕССИЯ бага #2 — изменившееся название синхронизированной записи обновляется, rawSummary НЕ трогается', async () => {
    const tracking = {
      plaudRecordingId: 'p1',
      status: PlaudSyncStatus.SYNCED,
      contentHash: 'old-hash',
      meetingId: 'm1',
      plaudCreatedAt: new Date('2026-09-01T10:00:00Z'),
    };
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.status === PlaudSyncStatus.SYNCED ? [tracking] : [])),
        findUnique: jest.fn().mockResolvedValue(tracking),
        upsert: jest.fn(),
      },
      meeting: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    const api = {
      listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
      getFile: jest.fn().mockResolvedValue(makeDetail('p1', 'Новое название встречи', '2026-09-01T10:00:00Z', 'Саммари встречи')),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.meeting.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { title: 'Новое название встречи' } });
    expect(prisma.meeting.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ rawSummary: expect.anything() }) }));
  });

  it('содержимое не изменилось (тот же contentHash) — Meeting.update не вызывается вовсе', async () => {
    const rawSummary = 'Саммари встречи';
    const title = 'Встреча';
    const { createHash } = require('crypto');
    const hash = createHash('sha256').update(`${title}\n${rawSummary}`).digest('hex');
    const tracking = { plaudRecordingId: 'p1', status: PlaudSyncStatus.SYNCED, contentHash: hash, meetingId: 'm1', plaudCreatedAt: new Date('2026-09-01T10:00:00Z') };
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockImplementation(({ where }: any) => Promise.resolve(where.status === PlaudSyncStatus.SYNCED ? [tracking] : [])),
        findUnique: jest.fn().mockResolvedValue(tracking),
        upsert: jest.fn(),
      },
      meeting: { findUnique: jest.fn(), update: jest.fn() },
    };
    const api = {
      listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
      getFile: jest.fn().mockResolvedValue(makeDetail('p1', title, '2026-09-01T10:00:00Z', rawSummary)),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.meeting.update).not.toHaveBeenCalled();
    expect(prisma.plaudSyncItem.upsert).not.toHaveBeenCalled();
  });

  it('сбой API при синхронизации одной записи — помечается FAILED, не роняет весь прогон (остальные записи обрабатываются)', async () => {
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection()), update: jest.fn() },
      plaudSyncItem: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
      meeting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'm2' }), update: jest.fn() },
    };
    const api = {
      listFiles: jest
        .fn()
        .mockResolvedValueOnce(
          // Plaud отдаёт newest-first — сервис делает .reverse(), поэтому
          // здесь порядок p2 (новее), затем p1 (старее), чтобы после
          // reverse() p1 обрабатывался первым (соответствует порядку
          // моков getFile ниже: сбой затем успех).
          makeListResponse([
            { id: 'p2', name: 'Успешная', created_at: '2026-09-01T11:00:00Z' },
            { id: 'p1', name: 'Сбойная', created_at: '2026-09-01T10:00:00Z' },
          ]),
        )
        .mockResolvedValueOnce(makeListResponse([])),
      getFile: jest.fn().mockRejectedValueOnce(new Error('Plaud API недоступен')).mockResolvedValueOnce(makeDetail('p2', 'Успешная', '2026-09-01T11:00:00Z', 'Саммари')),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.plaudSyncItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { plaudRecordingId: 'p1' }, create: expect.objectContaining({ status: PlaudSyncStatus.FAILED }) }),
    );
    expect(prisma.meeting.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ plaudRecordingId: 'p2' }) }));
  });

  it('данные до Phase J (Meeting импортирован, PlaudSyncItem ещё не создан) — досоздаёт tracking, обновляет только title', async () => {
    const prisma = {
      plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection({ lastSyncedCreatedAt: new Date('2026-09-01T10:00:00Z') })), update: jest.fn() },
      plaudSyncItem: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null), // ещё нет tracking-строки
        upsert: jest.fn(),
      },
      meeting: { findUnique: jest.fn().mockResolvedValue({ id: 'm-legacy' }), create: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    const api = {
      listFiles: jest.fn().mockResolvedValue(makeListResponse([])),
      getFile: jest.fn().mockResolvedValue(makeDetail('p-legacy', 'Обновлённое название', '2026-08-01T10:00:00Z', 'Саммари')),
      loadNoteContent: jest.fn().mockImplementation((note: any) => Promise.resolve(note.data_content)),
      findTranscriptNote: jest.fn().mockReturnValue(undefined),
    };
    // Ретрай-путь здесь не задействован (нет pending/synced tracking) — но
    // syncItem всё равно способен обработать легаси-запись, если её вызвать
    // напрямую (например, через будущий backfill) — используем privately
    // через тот же путь: findMany пустой, значит этот тест на самом деле
    // проверяет только findUnique-фолбэк — тестируем непосредственно через
    // discovery, где p-legacy встречается как "новая" запись.
    api.listFiles.mockResolvedValueOnce(makeListResponse([{ id: 'p-legacy', name: 'Обновлённое название', created_at: '2026-09-02T10:00:00Z' }])).mockResolvedValueOnce(makeListResponse([]));
    const service = new PlaudSyncService(prisma as any, api as any);

    await service.pullChanges('emp1');

    expect(prisma.meeting.update).toHaveBeenCalledWith({ where: { id: 'm-legacy' }, data: { title: 'Обновлённое название' } });
    expect(prisma.meeting.create).not.toHaveBeenCalled();
    expect(prisma.plaudSyncItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ meetingId: 'm-legacy', status: PlaudSyncStatus.SYNCED }) }),
    );
  });

  // Stage 2, Phase K (внешний аудит 21.09.2026, "MeetingSegment +
  // transcript ingestion") — best-effort, см. предупреждение в
  // plaud-api.service.ts/transcript-parser.ts. Здесь тестируется только
  // то, что этот сервис делает С УЖЕ РАСПАРШЕННЫМИ сегментами
  // (parseTranscriptSegments протестирован отдельно) — не реальный формат
  // Plaud API.
  describe('транскрипт (best-effort, см. предупреждение в plaud-api.service.ts)', () => {
    function baseMocks() {
      const prisma = {
        plaudConnection: { findUnique: jest.fn().mockResolvedValue(makeConnection()), update: jest.fn() },
        plaudSyncItem: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
        meeting: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'm1' }), update: jest.fn() },
        meetingSegment: { deleteMany: jest.fn(), createMany: jest.fn() },
        $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
      };
      const api = {
        listFiles: jest.fn().mockResolvedValueOnce(makeListResponse([{ id: 'p1', name: 'Встреча', created_at: '2026-09-01T10:00:00Z' }])).mockResolvedValueOnce(makeListResponse([])),
        loadNoteContent: jest.fn(),
        findTranscriptNote: jest.fn(),
        getFile: jest.fn().mockResolvedValue(makeDetail('p1', 'Встреча', '2026-09-01T10:00:00Z', 'Саммари встречи')),
      };
      return { prisma, api };
    }

    it('транскрипт-note не найден — MeetingSegment не трогается, summary всё равно синхронизируется', async () => {
      const { prisma, api } = baseMocks();
      api.findTranscriptNote.mockReturnValue(undefined);
      api.loadNoteContent.mockImplementation((note: any) => Promise.resolve(note.data_content));
      const service = new PlaudSyncService(prisma as any, api as any);

      await service.pullChanges('emp1');

      expect(prisma.meeting.create).toHaveBeenCalled();
      expect(prisma.meetingSegment.createMany).not.toHaveBeenCalled();
    });

    it('транскрипт-note найден и парсится — сохраняет сегменты (delete+createMany в транзакции)', async () => {
      const { prisma, api } = baseMocks();
      const transcriptNote = { data_type: 'origin_text_note', data_content: JSON.stringify([{ speaker: 'A', start: 0, end: 2, text: 'Привет' }]) };
      api.findTranscriptNote.mockReturnValue(transcriptNote);
      api.loadNoteContent.mockImplementation((note: any) => Promise.resolve(note.data_content));
      const service = new PlaudSyncService(prisma as any, api as any);

      await service.pullChanges('emp1');

      expect(prisma.meetingSegment.deleteMany).toHaveBeenCalledWith({ where: { meetingId: 'm1' } });
      expect(prisma.meetingSegment.createMany).toHaveBeenCalledWith({
        data: [{ meetingId: 'm1', order: 0, startMs: 0, endMs: 2000, speakerLabel: 'A', text: 'Привет' }],
      });
    });

    it('транскрипт-note найден, но не парсится (неожиданный формат) — не бросает, summary всё равно синхронизируется', async () => {
      const { prisma, api } = baseMocks();
      const transcriptNote = { data_type: 'origin_text_note', data_content: 'совсем не тот формат' };
      api.findTranscriptNote.mockReturnValue(transcriptNote);
      api.loadNoteContent.mockImplementation((note: any) => Promise.resolve(note.data_content));
      const service = new PlaudSyncService(prisma as any, api as any);

      await expect(service.pullChanges('emp1')).resolves.not.toThrow();

      expect(prisma.meeting.create).toHaveBeenCalled();
      expect(prisma.meetingSegment.createMany).not.toHaveBeenCalled();
    });
  });
});
